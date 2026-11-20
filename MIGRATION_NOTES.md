# OneXServer — notes techniques de la version pré-déploiement

Cette version est destinée à une **base MySQL neuve**. Le projet n'étant pas déployé, aucun script de migration ou de reprise d'anciennes tables n'est fourni. `initDbIfEmpty()` crée le schéma initial et `assertLatestSchema()` refuse une base qui ne correspond pas à ce schéma.

## Adresse portefeuille utilisateur

- `POST /app/signup` exige `wallet_address`.
- L'adresse est contrôlée comme une adresse EVM de 20 octets, normalisée au checksum et rejetée si elle est nulle ou égale à l'adresse de trésorerie.
- `auths.wallet_address` est obligatoire et unique.
- Aucune signature ni preuve cryptographique de propriété n'est demandée, conformément à la décision produit. Le contrôle syntaxique ne prouve pas que l'utilisateur contrôle la clé privée.
- `bsc_wallet_address_registry` constitue un registre permanent. Une adresse n'est jamais réattribuée après la suppression d'un compte ; le registre est volontairement conservé même si la ligne `auths` est supprimée.
- Cette adresse est fixe pour le compte et sert à identifier les dépôts entrants ainsi que la destination des remboursements et paiements sortants. `/app/set-payout-address` est conservée comme réponse informative en lecture seule.
- Les utilisateurs doivent envoyer les dépôts directement depuis l'adresse enregistrée. Un retrait d'une plateforme d'échange ou d'un portefeuille mutualisé peut exposer l'adresse de l'intermédiaire et sera traité comme transfert inconnu.

## Réception BSC-USD sur la trésorerie partagée

- Tous les dépôts arrivent directement sur `USDT_BEP20_TREASURY_ADDRESS` ; aucune adresse de dépôt dérivée par utilisateur n'est créée.
- Le watcher filtre exclusivement le contrat Binance-Peg BSC-USD approuvé, sur BNB Smart Chain Mainnet (chain ID 56), et les événements BEP-20 `Transfer` dont `to` est la trésorerie.
- L'utilisateur est identifié par `Transfer.from`, jamais par `transaction.from`.
- Un transfert n'est crédité automatiquement que si son horodatage de bloc est postérieur à l'inscription du compte, avec arrondi conservateur à la seconde suivante ; les transferts antérieurs ou ambigus sont enregistrés pour examen administratif.
- Les dépôts de comptes identifiés gardent les règles existantes de sessions de 60 minutes, minimum 20, maximum 100 BSC-USD, plafond de solde 300 XTU, limites hebdomadaires, réserves et contrôle de suspension.
- Les transferts dont l'expéditeur n'est pas enregistré dans `auths.wallet_address` sont enregistrés dans `bsc_unknown_incoming_transfers`. Ils ne sont jamais crédités automatiquement. L'administration peut les lister et les résoudre via `/admin/bsc/unknown-transfers/list` et `/admin/bsc/unknown-transfers/resolve` : affectation uniquement si l'adresse correspond exactement au portefeuille d'un compte, conservation sans crédit, ou mise en file d'un remboursement.
- La contrainte `UNIQUE(tx_hash,log_index)` assure l'idempotence de chaque événement.

## Résilience et reprise du scanner

- `bsc_incoming_scan_state` conserve le réseau, le contrat, la trésorerie, le bloc de départ, le dernier bloc scanné, son hash, la méthode de finalité et l'état de santé.
- Le watcher utilise `eth_getLogs` sur des plages bornées et préfère le tag `finalized`; si le RPC ne le prend pas en charge, il utilise `USDT_MIN_CONFIRMATIONS`.
- Les RPC HTTPS primaire et secondaire sont validés individuellement (chain ID 56, contrat présent et 18 décimales). Un RPC indisponible est ignoré temporairement ; si tous sont hors ligne au démarrage, le watcher reste actif et réessaie sans avancer le curseur. Lorsqu'un RPC redevient disponible, il est revalidé avant toute utilisation.
- `BSC_WS_RPC_URL` est facultatif et ne sert qu'à réveiller le scanner plus rapidement à l'arrivée d'un bloc. Le polling HTTPS et `eth_getLogs` restent la source de vérité et assurent la reprise même lorsque le WebSocket est indisponible.
- Chaque reçu, le contenu exact du log et le hash du bloc canonique sont revérifiés avant traitement.
- Les événements et leur traitement métier sont enregistrés avant l'avancement du curseur. Si MySQL, RPC ou le processus est interrompu, le même intervalle est réessayé ; les clés uniques empêchent un double traitement.
- Si le hash du dernier bloc enregistré ne correspond plus à la chaîne canonique, ou si l'identité réseau/contrat/trésorerie diffère de celle enregistrée dans le curseur, le scanner passe en `manual_review` et bloque les crédits automatiques jusqu'à rapprochement administratif. L'adresse de trésorerie doit donc rester fixe après l'initialisation du scanner.
- `POST /admin/bsc/incoming-scanner/status` expose l'état du scanner. `POST /admin/bsc/incoming-scanner/reconcile` ne peut être utilisé qu'en `manual_review` et ne permet qu'un retour arrière vers un bloc canonique finalisé strictement antérieur au curseur enregistré. Chaque opération est auditée dans `bsc_scan_admin_events` ; une avance du curseur est interdite afin de ne pas sauter des dépôts.
- `USDT_INCOMING_START_BLOCK` est facultatif. Lors de la toute première initialisation, une valeur vide démarre au bloc alors finalisé ; renseigner explicitement le bloc de départ avant d'accepter des dépôts si un historique antérieur doit être analysé. Après création du curseur, les redémarrages reprennent toujours depuis MySQL.
- Les défaillances RPC, réponses incomplètes, reçus incohérents et échecs SQL ne font jamais avancer le curseur.
- L'adresse de trésorerie n'est pas divulguée par `/app/user-last-stock` tant que le curseur n'est pas initialisé, sain et rattrapé jusqu'au dernier bloc finalisé ; elle est masquée en `manual_review` ou pendant le rattrapage initial de l'historique. Au démarrage, le serveur refuse également d'utiliser comme trésorerie une adresse présente dans le registre permanent des portefeuilles utilisateur.

## Comptabilité et frais

- Aucun sweep ni transfert de consolidation depuis des adresses individuelles n'existe. Les frais de gas de sweep et leur allocation pro-rata aux recharges ont été supprimés.
- Les recharges arrivent directement dans la trésorerie ; aucun gas sortant OneX n'est dépensé pour les consolider. Les frais `tfees` de recharge sont donc retenus intégralement selon le modèle comptable.
- Les paiements sortants, remboursements, disbursements et paiements vendeurs restent contrôlés par `BSC_MAX_TX_FEE_BSC_USD` (maximum absolu 0.4 BSC-USD), évalué avec le gas estimé et le cours Chainlink BNB/USD.
- `bsc-price-oracle.js` lit `latestRoundData()` et `decimals()` du flux Chainlink BNB/USD sur BSC. Le cours doit être positif et frais ; aucun cours périmé n'est utilisé pour autoriser une nouvelle transaction.

## Prix individuel

Le seuil individuel est désormais :

```text
B = A * (1 + 3 * applied_tfees_rate / 100)
```

Pour `tfees=3%`, le seuil est `A * 1.09`, soit 9 % au-dessus de A. Au démarrage, les cycles `watching` sont recalculés avec le multiplicateur 3, y compris leur entrée d'historique active. Les cycles déjà `paused` conservent leur déclenchement historique.

## Routes administratives du scanner

- `POST /admin/bsc/incoming-scanner/status` : consulte le curseur persistant, la finalité et l'état de santé.
- `POST /admin/bsc/incoming-scanner/reconcile` : reprend uniquement un scanner en `manual_review`, en reculant vers un bloc canonique finalisé strictement antérieur au curseur ; la raison et les anciens/nouveaux hashes sont consignés.
- `POST /admin/bsc/unknown-transfers/list` : liste les événements entrants dont l'expéditeur ne correspond à aucun compte actif connu.
- `POST /admin/bsc/unknown-transfers/resolve` : permet l'affectation uniquement au compte dont l'adresse enregistrée correspond exactement à `Transfer.from`, la conservation sans crédit ou la mise en file d'un remboursement vers l'expéditeur observé.

## Fichiers et responsabilités

- `routes.js` : inscription avec portefeuille fixe, disclosure de la trésorerie commune, traitement des sessions de recharge et routes administratives de résolution des transferts inconnus.
- `pay.js` : initialisation et validation individuelle des RPC, hint WebSocket facultatif, scan finalisé, curseur persistant, vérification canonique, déduplication et réconciliation administrative.
- `db.js` : schéma initial frais, registre portefeuille permanent, état du scanner et transferts inconnus.
- `user-price-accounting.js` : calcul du nouveau seuil individuel et recalcul des cycles actifs.
- `bsc-price-oracle.js`, `bsc-fee-accounting.js` et `disbursement.js` : cours Chainlink et contrôle des frais BSC sortants.
- `terms_fr.html`, `terms_en.html`, `privacy_fr.html`, `privacy_en.html` : règles publiques actualisées.

## Avant toute activation Mainnet

1. Configurer une trésorerie BSC dédiée, son adresse publique et les RPC primaires/secondaires HTTPS.
2. Fournir `USDT_INCOMING_START_BLOCK` explicitement si des paiements peuvent être reçus avant le premier démarrage du scanner.
3. Vérifier que le fournisseur RPC prend en charge `eth_getLogs` sur les plages nécessaires et qu'il accepte le tag `finalized` ; la solution de repli aux confirmations doit aussi être testée.
4. Vérifier que l'adresse de trésorerie affichée par `/app/user-last-stock` est exactement celle surveillée par le scanner et que l'application cliente envoie les dépôts depuis `wallet_address` inscrit.
5. Tester les scénarios de transfert normal, expéditeur inconnu, RPC indisponible, redémarrage, doublon, changement de hash de curseur et compte désactivé avant d'activer `USDT_PAYMENTS_ENABLED`.
6. Utiliser exclusivement une base vide créée par le schéma actuel. Aucune migration n'est attendue ni fournie.
