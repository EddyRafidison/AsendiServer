# OneXServer — intégration des nouvelles règles XTU

**Date de référence : 24 novembre 2026**  
**Périmètre :** contrat XTU, retraits vers les portefeuilles personnels, dépôts XTU, couverture BSC-USD, comptabilité postérieure à l'activation du disbursement global, schéma neuf et documentation bilingue.  
**État :** code intégré et contrôles locaux partiels effectués ; validation blockchain réelle non effectuée.

## 1. Contrat XTU et séparation des portefeuilles

- `contracts/OneXToken.sol` définit un token BEP-20 compatible, déployable sur BNB Smart Chain Mainnet (Chain ID 56), avec 18 décimales et une offre fixe de 100 milliards de XTU.
- L'intégralité de l'offre initiale est mintée au portefeuille principal OneX (Hot Wallet). Le portefeuille de distribution XTU est défini séparément comme destinataire des commissions ; il ne reçoit pas l'offre initiale.
- La commission contractuelle est de 0,1 % pour les transferts externes via `transfer` et `transferFrom`.
- La seule exemption est la paire exacte Hot Wallet → Distribution Wallet. Il n'existe pas d'exemption générale fondée uniquement sur l'adresse de l'émetteur ou du destinataire.
- Lorsque le Distribution Wallet est l'émetteur, la commission reste dans son propre solde sans transfert vers lui-même. `TransferWithFee` permet de reconstruire les montants brut, net, commission et exemption ; `FeeCollected` identifie les commissions effectivement transférées.
- Les secrets XTU du Hot Wallet et du Distribution Wallet sont conservés dans des fichiers distincts. Ils ne doivent pas réutiliser les clés BSC-USD.

## 2. Retraits XTU vers le portefeuille personnel

- `POST /app/xtu2wallet` accepte un montant brut minimal de 1 XTU. La destination est exclusivement l'adresse BSC déjà enregistrée dans `auths.wallet_address` ; aucune adresse arbitraire, clé privée ou seed n'est demandée au client.
- `POST /app/xtu2wallet/status` permet à l'utilisateur de consulter sa propre demande.
- `POST /admin/withdraw/start` gère `start`, `stop` et `status`, avec le contrôle administratif password + PIN existant. La commande est fermée par défaut et reste indépendante des contrôles de décaissement BSC-USD.
- Le serveur convertit l'estimation de gas BNB avec Chainlink BNB/USD, la déduit du brut avant l'appel au contrat, puis laisse le contrat prélever une seule fois la commission de 0,1 %. Une estimation supérieure à `BSC_MAX_TX_FEE_BSC_USD=0.4` reporte/refuse temporairement l'opération.
- Le worker persiste transaction brute signée, hash et nonce avant diffusion. En cas de réponse RPC incertaine, il réconcilie la transaction et ne soumet que la même transaction signée ; si le nonce avance sans preuve du hash connu, il bloque le traitement et place la demande en `manual_review`.
- Après finalité, le reçu et les événements de contrat sont rapprochés. Le gas réel, la commission réelle, le net effectivement reçu, le hash, le nonce et le reçu sont enregistrés. L'activité est finalisée et la notification Telegram est mise en file uniquement après confirmation comptable.
- `common.xtu_wallets` augmente du net reçu par le portefeuille personnel. Le principal est réservé avec le prix individuel capturé ; il est déplacé vers `common.inactive_init_asset` après confirmation. Un échec on-chain définitif restaure le principal et libère la couverture une seule fois, tout en enregistrant le gas réellement consommé.
- Un retrait XTU ne réinitialise ni ne redémarre le cycle de rémunération individuel. Aucun appel à `recordUserOperationTx` n'est effectué par le flux de retrait.

## 3. Couverture BSC-USD

- `common.xtu_wallets` est un solde évolutif du XTU net externalisé et pas encore retourné ; il est non négatif et peut diminuer.
- `common.xtu_wallets_reserved` représente la couverture provisionnellement réservée aux retraits XTU en cours. La réservation est ajustée avec le net estimé actualisé avant signature, puis libérée après confirmation ou échec définitif.
- La couverture XTU externalisée et celle des retraits en cours sont exclues de la liquidité libre du Hot Wallet. Elles ne sont pas physiquement transférées et ne réduisent pas, à elles seules, le solde BSC-USD détenu.
- Lorsqu'un dépôt XTU est effectivement consolidé au Distribution Wallet, `common.xtu_wallets` diminue du montant brut retourné, avant frais OneX et gas. Un événement non finalisé, en attente ou non consolidé ne libère pas la couverture. Un compteur insuffisant déclenche une réconciliation manuelle au lieu d'une valeur négative.
- `common.unit_price` est un prix global absolu et monotone ; il n'est jamais abaissé par un simple recalcul du ratio `total_units_price / backed_units`.

## 4. Dépôts XTU

- Les routes officielles sont `POST /app/deposit`, `/app/deposit/availability` et `/app/deposit/status`, avec `asset: "XTU"`. Les dépôts BSC-USD et XTU restent séparés par actif et par registre. Aucun endpoint `/app/recharge` n'est conservé.
- Le scanner XTU surveille exclusivement le contrat XTU configuré. Il vérifie l'émetteur lié à un compte, le reçu, l'événement `TransferWithFee`, les transferts `Transfer` et `FeeCollected`, le contrat, le hash/log, le bloc et la finalité.
- Les frais de réception contractuels de 0,1 % sont rapprochés séparément du net reçu par le Hot Wallet. Seul le montant de dépôt identifié est consolidé Hot Wallet → Distribution Wallet ; l'offre initiale et les autres soldes du Hot Wallet ne sont jamais balayés.
- Les limites sont fixes : minimum 70 XTU, maximum 140 XTU par utilisateur et par période glissante de sept jours. Les sessions se regroupent pendant 60 minutes à partir du premier transfert finalisé ; le regroupement initial est limité à 30 jours ; les montants hors plage et dépassements sont mis en attente et réévalués après sept jours.
- Le plafond de première tranche de crédit est distinct de la limite de réception et vaut 100 XTU par défaut (`XTU_DEPOSIT_MAX_INITIAL_CREDIT_XTU`). Le reliquat est conservé et réévalué pour une tranche ultérieure ; frais OneX et gas ne sont pas déduits une seconde fois.
- Hors disbursement global, les frais de dépôt OneX représentent 75 % du taux `tfees`. Pendant un disbursement global déjà activé, ces frais sont nuls. Dans les deux périodes, le gas BNB réel de la consolidation est calculé depuis le reçu et converti par Chainlink en équivalent XTU, puis déduit du montant créditable. Le plafond 0,4 BSC-USD concerne le coût estimé, pas un frais fixe.
- Les actifs initiaux sont crédités au prix global `common.unit_price`, jamais au prix individuel. Les réserves sont consommées dans l'ordre `inactive_init_asset`, réserve vendeurs, puis `backed_units` en dernier recours. La capacité est contrôlée à la clôture et juste avant le crédit.
- L'audit de crédit conserve les hashes/logs des transferts personnels d'origine ainsi que le hash distinct de la consolidation Hot Wallet → Distribution Wallet.

## 5. Dépôts et règlements XTU après activation du disbursement global

- Les dépôts BSC-USD restent suspendus selon le mécanisme global, mais les dépôts XTU restent actifs ; leurs frais OneX sont nuls et le gas réel reste imputé.
- La photographie initiale du disbursement global reste inchangée. Les actifs initiaux acquis en XTU après activation sont isolés et ne créent aucune nouvelle obligation BSC-USD.
- Chaque crédit postérieur à l'activation crée une ligne dans `xtu_global_settlement_ledger` et une demande de paiement XTU dédiée. Les XTU associés sont protégés contre toute réutilisation.
- Le règlement est effectué exclusivement en XTU depuis le Distribution Wallet. Le montant brut est calculé de façon que le bénéficiaire reçoive exactement son net après commission contractuelle de 0,1 %. Le gas BNB du règlement est une dépense séparée enregistrée au reçu.
- Le registre conserve l'identifiant du disbursement global, l'utilisateur, le lot, la tranche, le hash de dépôt source, les hashes/logs source, le hash de consolidation, les montants brut/frais/gas, le prix global, les actifs crédités, les XTU réservés et l'état du règlement.

## 6. Schéma, documentation et intégration cliente

- Le schéma définitif est intégré directement dans `db.js`, y compris les tables de contrôle, audit, lots, événements, consolidations, crédits, outbox email et règlements XTU. Aucun script de migration SQL n'est ajouté ; l'initialisation cible une base neuve.
- `README.md`, les exemples `.env.xtu*`, les guides d'intégration Android et les quatre documents `terms_fr.html`, `terms_en.html`, `privacy_fr.html`, `privacy_en.html` ont été mis à jour.
- La terminologie officielle « dépôt » remplace « recharge » dans les interfaces et commentaires métier concernés.
- Le backend utilisait déjà les types d'activité `1` (P2P), `2` (achat/dépôt), `3` (vente) et `4` (welcome bonus). Le type `5` est utilisé pour le retrait XTU, premier type numérique inutilisé observé dans le code serveur. L'archive ne contient pas le code complet de l'application Android ni son mapping d'affichage des activités : ce mapping doit encore être vérifié/intégré dans le client avant publication.

## 7. Vérifications effectuées et limites

- `node scripts/syntax-check.js` : réussi, 92 fichiers JavaScript contrôlés.
- `node --check db.js`, `routes.js`, `xtu-deposit-worker.js` et `xtu-withdrawal-worker.js` : réussis.
- Tests ciblés sans dépendances manquantes (`account-deactivation-deposits`, `deposit-pending-rules`, `refund-accounting-lifecycle`) : 28/28 réussis.
- Suite complète `npm test` : 126 tests réussis sur 147. Les 21 fichiers de test restants n'ont pas pu être chargés à cause de dépendances absentes (`bignumber.js` dans 19 fichiers, `ethers` dans 1, `ganache` dans 1). L'installation npm a expiré avant de terminer ; ces erreurs ne constituent pas des échecs fonctionnels établis des tests concernés.
- Le test EVM `tests/xtu-token-contract.test.js` n'a pas pu s'exécuter faute de `ganache`. Le compilateur `solc` et les packages OpenZeppelin ne sont pas installés dans l'environnement utilisé ; la compilation Solidity n'a donc pas été exécutée.
- Aucun test d'intégration MySQL, RPC BSC, testnet, mainnet, déploiement ou transfert réel n'a été effectué. Aucun test blockchain n'est déclaré comme réalisé.

**Avant activation réelle :** installer les dépendances (`npm install`), exécuter `npm test` et `npm run compile:xtu`, exécuter les tests EVM locaux, valider le schéma sur une nouvelle base MySQL, puis effectuer des essais de bout en bout sur un environnement BSC de test. Le mapping d'affichage des activités dans l'application Android complète reste à confirmer, car cette application n'est pas incluse dans l'archive examinée.
