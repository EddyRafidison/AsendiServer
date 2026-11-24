# Mise à jour OneXServer — retraits externes XTU

**Date : 24 novembre 2026**  
**Périmètre :** intégration des règles XTU validées, contrôle administratif, comptabilité, contrat BEP-20, worker de transfert et documentation. Projet pré-déploiement à schéma neuf, sans script de migration.

## 1. Contrat XTU

- Ajout de `contracts/OneXToken.sol`, contrat ERC-20 compatible BEP-20 pour BNB Smart Chain, chaîne 56, 18 décimales.
- Offre fixe de 100 milliards de XTU, émise une seule fois à la construction vers le portefeuille de distribution. Aucune fonction publique de création supplémentaire n'est exposée.
- Commission contractuelle obligatoire de 0,1 % appliquée dans `_update`, donc pour `transfer` et `transferFrom`.
- La commission est conservée dans le portefeuille de distribution. Lorsque celui-ci est l'émetteur, la part de commission reste dans son solde sans transfert vers lui-même.
- Émission de `FeeCollected` pour rendre le prélèvement vérifiable dans les reçus on-chain.

## 2. Demande de retrait et contrôle administratif

Nouvelles routes :

- `POST /app/xtu2wallet` : demande de retrait brut d'au moins 1 XTU. Le client ne choisit pas l'adresse de destination ; le serveur utilise exclusivement l'adresse BSC enregistrée dans `auths.wallet_address`.
- `POST /app/xtu2wallet/status` : consultation authentifiée du statut d'une demande à partir de sa référence.
- `POST /admin/withdraw/start` : actions `start`, `stop` et `status`, protégées par le mot de passe et le PIN administrateur. Un motif est exigé pour l'ouverture et la fermeture.

Le contrôle est fermé par défaut. L'activation nécessite également un worker activé dans `.env.xtu`, un contrat conforme sur la chaîne 56 et une clé correspondant au portefeuille de distribution configuré. Une demande en `manual_review` bloque la réouverture automatique.

## 3. Frais et montants

- La commission de 0,1 % est calculée par le contrat, et non déduite une seconde fois côté serveur.
- Le serveur estime les frais BNB et retire leur équivalent XTU du montant brut avant d'appeler le contrat.
- Le contrat calcule ensuite 0,1 % sur le montant transmis et envoie le net à l'utilisateur.
- Exemple indicatif : pour 100 XTU bruts et 0,10 XTU de gaz estimé, le contrat reçoit 99,90 XTU, retient 0,0999 XTU et envoie 99,8001 XTU. Les frais combinés estimés sont 0,1999 XTU.
- Le plafond de frais BSC existant reste applicable : une estimation supérieure à `BSC_MAX_TX_FEE_BSC_USD` (plafond maximal de 0,4 BSC-USD) ne doit pas être exécutée.
- Les valeurs estimées et réelles de la commission contractuelle et du gaz sont séparées dans `xtu_withdrawals`. `activities.fees` contient l'équivalent combiné réel converti dans l'unité initiale attendue par l'historique existant ; `activities.bsc_fee_cost_usd` conserve le coût réseau réel.
- Le retrait XTU ne modifie pas `common.total_tfees`.

## 4. Comptabilité et cycle individuel

- `users_stock.balance` reste exprimé en actifs initiaux. Le principal réservé est calculé avec le prix individuel capturé lors de la demande ; le solde n'est jamais diminué par une quantité XTU brute.
- Le cycle de rémunération individuel n'est ni redémarré ni modifié par l'externalisation.
- `activities.type=5` est réservé au retrait XTU. L'émetteur est le nom d'utilisateur et le destinataire historique est `<username>-WALLET`.
- `common.xtu_wallets` cumule seulement le XTU net réellement envoyé à l'adresse personnelle. Cette valeur n'est pas ajoutée une seconde fois aux réserves.
- Le principal brut est converti au prix individuel capturé : `reserved_initial_asset = gross_amount / effective_unit_price`, puis `reserved_xtu_value = reserved_initial_asset * effective_unit_price`.
- À la réservation, `common.total_units_price` diminue de `reserved_xtu_value` et `common.backed_units` diminue de `reserved_initial_asset`. Les actifs réservés ne sont pas ajoutés à la réserve inactive tant que la transaction est en attente, afin qu'ils ne soient pas réutilisés.
- Après confirmation blockchain canonique et atteinte de la profondeur configurée, `common.inactive_init_asset` augmente de `reserved_initial_asset`, tandis que `common.xtu_wallets` augmente uniquement du XTU net réellement envoyé.
- En cas d'échec on-chain définitif, le principal utilisateur et `common.backed_units` sont restaurés, ainsi que la valeur XTU réservée, déduction faite du coût BNB réellement consommé. Aucun actif n'est ajouté à `inactive_init_asset` pour un retrait échoué.
- `common.unit_price` conserve son prix antérieur comme plancher absolu et ne peut donc jamais diminuer. Il augmente seulement si le nouveau ratio `total_units_price / backed_units` dépasse ce plancher.

## 5. Sécurité transactionnelle

- Les retraits sont persistés et réservés en base avant le transfert.
- Le worker enregistre la transaction signée, son hash et son nonce avant la diffusion.
- En cas de résultat RPC incertain, il recherche le hash et le nonce puis ne rediffuse que la même transaction brute signée. Si le nonce du portefeuille a avancé sans preuve du hash attendu, le retrait est placé en `manual_review` plutôt que d'en créer un second.
- Le worker exige la profondeur de confirmation configurée, le bloc canonique et les événements `Transfer` et `FeeCollected` correspondant aux montants réservés.
- Un retrait en attente ou en examen manuel bloque les opérations qui changeraient le principal de l'utilisateur. L'activation d'un décaissement global est également bloquée par les retraits XTU non résolus.
- Une anomalie de règlement après confirmation on-chain bascule le retrait en `manual_review` et arrête les envois ultérieurs du worker jusqu'à réconciliation.
- La file Telegram existante n'est alimentée qu'après confirmation et règlement comptable, avec une clé d'événement idempotente.
- OneX n'observe ni ne suit le solde du portefeuille personnel de l'utilisateur après le transfert.

## 6. Configuration et fichiers

Nouveaux fichiers principaux :

- `contracts/OneXToken.sol`
- `xtu-withdrawal-policy.js`
- `xtu-withdrawal-chain.js`
- `xtu-withdrawal-routes.js`
- `xtu-withdrawal-worker.js`
- `xtu-withdrawal-accounting.js`
- `.env.xtu.example`
- `scripts/compile-xtu.js`
- `scripts/deploy-xtu.js`
- `android-integration/XTU_EXTERNALIZATION.md`
- `tests/xtu-withdrawal-accounting.test.js`

`package.json` ajoute OpenZeppelin Contracts, Solc et Ganache ainsi que les commandes `compile:xtu`, `deploy:xtu` et `xtu-withdrawals`. `index.js` démarre le worker XTU séparé ; celui-ci reste désactivé par défaut.

Le fichier `.env.xtu.example` contient uniquement des valeurs fictives. Il faut le copier vers `.env.xtu` et y saisir le portefeuille et la clé de distribution dédiés. La clé ne doit pas être réutilisée depuis `.env.treasury` ou `.env.disbursement`. L'URL RPC sortante reste `BSC_RPC_URL` dans le `.env` principal et doit pointer sur Chainstack.

Le projet n'étant pas encore déployé, aucun script de migration SQL n'est inclus. Il faut initialiser une base neuve à partir du schéma courant de `db.js`. `initDbIfEmpty()` crée les nouvelles tables, le compteur `common.xtu_wallets`, les verrous et le contrôle fermé automatiquement. Aucune conversion ou reprise de données historiques n'est effectuée.

## 7. Vérifications effectuées et limites

- `node scripts/syntax-check.js` : **réussi**, 89 fichiers JavaScript contrôlés.
- Les tests orphelins `tests/bsc-fee-allocations.test.js` et `tests/tfees-bsc-allocation.test.js`, qui référençaient des modules absents du dépôt, ont été supprimés. Des tests ciblés de la réservation, de l'ajout à la réserve inactive, de la restauration après échec et du maintien du prix global ont été ajoutés dans `tests/xtu-withdrawal-accounting.test.js`.
- L'exécution complète de `npm test` reste conditionnée à l'installation des dépendances déclarées (`bignumber.js`, `ethers`, `ganache`, entre autres) ; les résultats seront indiqués après leur exécution dans un environnement disposant de ces dépendances.
- `npm test` : **126 tests réussis sur 146 ; 20 tests n'ont pas pu charger**. Les échecs de chargement sont dus à l'absence des paquets `bignumber.js` (18 fichiers de test), `ethers` (1) et `ganache` (1). L'installation npm a expiré avant de terminer ; aucun de ces échecs ne constitue donc un échec fonctionnel établi du code testé.
- La compilation Solidity, les tests Ganache, les tests d'intégration MySQL, les tests RPC et tout déploiement BNB Smart Chain n'ont pas été exécutés, car les dépendances ne sont pas installées et aucun nœud BSC n'est configuré dans cet environnement.

**Important :** cette mise à jour constitue une intégration du code et des garde-fous, pas un audit de sécurité du contrat ni une preuve de fonctionnement en production. Avant toute ouverture réelle, installer les dépendances, exécuter `npm test` et `npm run compile:xtu`, exécuter les tests EVM locaux, puis déployer et vérifier le contrat sur un environnement de test avant la production. La procédure de déploiement documentée cible explicitement BNB Smart Chain mainnet ; ne l'exécuter qu'après ces contrôles.
