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

- `POST /app/xtu2wallet` accepte un montant brut minimal de 5 XTU. La destination est exclusivement l'adresse BSC déjà enregistrée dans `auths.wallet_address` ; aucune adresse arbitraire, clé privée ou seed n'est demandée au client.
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
- Les limites de dépôt sont communes et configurables : minimum brut de 20 XTU et maximum brut de 100 XTU par session de 60 minutes. Il n’existe pas de plafond hebdomadaire sur les montants entrants. La limite de sept jours compte uniquement les achats financés par les réserves système de OneX : un achat par utilisateur, quel que soit le montant. Les dépôts suivants peuvent être financés exclusivement par les réserves de campagnes vendeurs actives et disponibles sans consommer ce droit OneX ; les vendeurs activent volontairement leur participation. Un transfert individuel ou une session supérieure à 100 XTU est mis en attente pour examen du support.
- Le plafond de première tranche de crédit est distinct de la limite de réception et vaut 100 XTU par défaut (`XTU_DEPOSIT_MAX_INITIAL_CREDIT_XTU`). Le reliquat est conservé et réévalué pour une tranche ultérieure ; frais OneX et gas ne sont pas déduits une seconde fois.
- Hors disbursement global, les frais de dépôt OneX représentent 75 % du taux `tfees`. Pendant un disbursement global déjà activé, ces frais sont nuls. Dans les deux périodes, le gas BNB réel de la consolidation est calculé depuis le reçu et converti par Chainlink en équivalent XTU, puis déduit du montant créditable. Le plafond 0,4 BSC-USD concerne le coût estimé, pas un frais fixe.
- Les actifs initiaux sont crédités au prix global `common.unit_price`, jamais au prix individuel. Les réserves sont consommées dans l'ordre `inactive_init_asset`, réserve vendeurs, puis `backed_units` en dernier recours. La capacité est contrôlée à la clôture et juste avant le crédit.
- L'audit de crédit conserve les hashes/logs des transferts personnels d'origine ainsi que le hash distinct de la consolidation Hot Wallet → Distribution Wallet.

### Règle hebdomadaire de financement OneX (commune BSC-USD / XTU)

- La fenêtre de 7 jours ne plafonne pas les montants entrants. Les limites de réception restent 20 à 100 unités brutes par session de 60 minutes.
- Elle autorise un seul achat financé par les réserves système OneX par utilisateur sur une période glissante de 7 jours, quel que soit le montant. Dès qu'une part positive d'un achat est financée par OneX, il consomme cette possibilité ; les tranches ultérieures du même lot ne la consomment pas une seconde fois.
- Le compteur commun aux deux actifs est fondé sur une activité `type=2` dont `sender=OneX` et `receiver=username`. Les crédits issus des campagnes vendeurs sont enregistrés avec `sender=XUSER` et ne consomment pas ce droit.
- Lorsque le droit est déjà utilisé, le nouvel achat ne peut être financé que par les réserves vendeurs actives et disponibles ; le chemin vendeur n'utilise pas `inactive_init_asset` ni `backed_units`. Le worker réévalue régulièrement les lots en attente afin qu'une campagne active puisse permettre un crédit avant la fin des sept jours.
- Une campagne est créée par OneX après activation explicite d'un vendeur éligible via `POST /app/join-system-sellers`. L'activation réserve 50 % du principal du vendeur selon les règles d'éligibilité ; aucune réserve vendeuse n'est immobilisée sans participation volontaire.

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

## 7. Vérifications effectuées et limites — révision du 24 novembre 2026

- `node scripts/syntax-check.js` : réussi, 94 fichiers JavaScript contrôlés.
- Tests de contrat source/configuration, règles de dépôt en attente et endpoints : 21/21 réussis (`deposit-endpoint-contract`, `deposit-pending-rules`, `xtu-new-thresholds-contract`). Ces tests vérifient les contrats d'interface et les invariants de source ; ils ne remplacent pas les tests numériques qui chargent les modules métier.
- Schéma `db.js` : 65 déclarations `CREATE TABLE` analysées ; aucun nom de table ou de colonne dupliqué détecté.
- Documents HTML : les quatre pages `terms_fr.html`, `terms_en.html`, `privacy_fr.html` et `privacy_en.html` passent le contrôle de structure.
- Configuration : les seuls paramètres partagés de réception sont `DEPOSIT_MIN_AMOUNT=20` et `DEPOSIT_MAX_AMOUNT=100` dans `.env.example`. Les anciens paramètres `XTU_DEPOSIT_MIN_AMOUNT` et `XTU_DEPOSIT_MAX_AMOUNT` sont absents des exemples et rejetés s'ils sont encore définis dans l'environnement XTU.
- Aucun script de migration SQL n'a été ajouté ; le schéma définitif reste intégré à `db.js` pour l'initialisation d'une nouvelle base.

### Vérifications non exécutées

L'environnement de travail ne contient pas `node_modules` et les modules `bignumber.js`, `ethers`, `mysql2` et `dotenv` ne sont pas résolus. Les tests métier numériques qui chargent ces bibliothèques, la suite complète `npm test`, la compilation Solidity et les tests EVM n'ont donc pas été exécutés dans cette révision. Aucun résultat de ces tests n'est présenté comme réussi ou échoué.

Aucun test d'intégration MySQL, appel RPC de validation financière, essai BSC testnet/mainnet, transaction réelle ou déploiement n'a été effectué. L'archive ne contient pas l'application Android complète ; le mapping d'affichage du type d'activité `5` reste à confirmer dans le client natif.

## 8. Ajustements complémentaires — configuration 20–100 et seuil de 100 XTU

- Les dépôts BSC-USD et XTU partagent une seule paire de paramètres : `DEPOSIT_MIN_AMOUNT=20` et `DEPOSIT_MAX_AMOUNT=100`. Le minimum brut de 20 et le maximum brut de 100 s'appliquent au total d'une session de dépôt de 60 minutes ; il n'existe aucun plafond hebdomadaire sur le montant des transferts entrants. La règle hebdomadaire porte uniquement sur le financement par les réserves système : un achat financé par OneX par utilisateur sur sept jours glissants, quel que soit son montant. Après consommation de cette possibilité, un dépôt admissible peut encore être crédité exclusivement par les réserves de campagnes vendeurs actives et disponibles, sans consommer le droit OneX ; les vendeurs activent volontairement leur campagne. Un transfert individuel ou une session supérieure à 100 est mis en attente pour examen du support dans les deux scanners. Les lignes `pending_support` n'ont pas d'échéance de libération automatique. Les anciens paramètres XTU `XTU_DEPOSIT_MIN_AMOUNT` et `XTU_DEPOSIT_MAX_AMOUNT` ne constituent plus une seconde source de configuration.
- Le retrait XTU vers le portefeuille personnel exige désormais un montant brut minimal de 5 XTU. Cette règle est limitée à `POST /app/xtu2wallet` et ne change pas le minimum distinct des transferts P2P ni celui des demandes de disbursement global.
- Les dépôts XTU finalisés et éligibles sont consolidés du Hot Wallet vers le Distribution Wallet par lots FIFO d'au moins 100 XTU effectivement reçus par le Hot Wallet. Plusieurs lots utilisateurs peuvent être réunis. Le transfert porte uniquement sur les montants de dépôt identifiés ; l'offre initiale conservée dans le Hot Wallet n'est jamais balayée.
- Le gas réel de consolidation est réparti de manière déterministe entre les lots sources et conservé dans le registre d'audit. Le seuil de 100 XTU est un minimum de consolidation interne, distinct du minimum et du maximum par session, de la règle de financement OneX limitée à un achat sur sept jours et du plafond de première tranche.
- Le plafond de première tranche de crédit reste un paramètre distinct (`MAX_DEPOSIT_INITIAL_CREDIT_BSC_USD` ou `XTU_DEPOSIT_MAX_INITIAL_CREDIT_XTU`). Il ne constitue pas une deuxième limite de réception.
- L'API XTU expose `consolidation_minimum_batch_xtu`, afin que le client Android distingue la limite de réception du minimum de consolidation interne.
