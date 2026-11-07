# OneX — Recharges BSC-USD sur BNB Smart Chain

## 1. Règles fonctionnelles appliquées

Cette version utilise une adresse de dépôt BEP-20 propre à chaque compte OneX. Aucune conversion vers TRON ou Ethereum n'est effectuée.

Le contrat accepté est strictement le contrat Binance-Peg BSC-USD indiqué plus bas. Il ne faut pas le présenter comme un contrat USD₮ directement émis par Tether.

| Règle | Valeur |
|---|---:|
| Réseau | BNB Smart Chain Mainnet |
| Chain ID | `56` |
| Contrat accepté | Binance-Peg BSC-USD |
| Décimales | 18 |
| Montant minimum par recharge | 70 BSC-USD |
| Montant maximum par recharge | 140 BSC-USD |
| Fréquence | Une recharge créditée au maximum tous les 7 jours par utilisateur |
| Solde maximal | 300 One-Val |
| Délai de paiement après création de la commande | 60 minutes |
| Seuil de consolidation par adresse | 70 BSC-USD |
| Âge maximal avant consolidation | 30 jours depuis le plus ancien transfert non consolidé |

Le contrôle des sept jours utilise la dernière activité de crédit OneX dans `activities` :

```sql
WHERE sender='ONEX' AND receiver=? AND type=2
ORDER BY record_date DESC, record_time DESC, id DESC
LIMIT 1
```

Les montants `users_stock.balance` restent directement exprimés en One-Val. Le plafond de 300 est fixé dans `recharge-policy.js` et `db.js`, il n'est pas remplacé par `STOCK_LIMIT` dans le fichier `.env`.

Une recharge demandée doit être comprise entre 70 et 140 BSC-USD. Pour être crédité automatiquement, le montant reçu doit également correspondre exactement au montant demandé (précision maximale : 18 décimales). Un transfert qui ne respecte pas une des règles n'est pas crédité : il passe dans le registre `pending_support` et une notification est mise en file d'attente.

## 2. Identité du token

```text
Réseau       : BNB Smart Chain Mainnet
Chain ID     : 56
Standard     : BEP-20
Token        : Binance-Peg BSC-USD
Contrat      : 0x55d398326f99059fF775485246999027B3197955
Décimales    : 18
```

Le backend refuse tout autre contrat ou toute autre configuration de décimales. Le symbole affiché dans un Wallet n'est pas utilisé pour identifier le token : seule l'adresse du contrat est déterminante.

## 3. Architecture des adresses de dépôt

Chaque utilisateur reçoit une adresse BNB Smart Chain dérivée d'une branche HD Wallet dédiée :

```text
m/44'/60'/0'/0/index
```

L'adresse est générée localement par `ethers.js`. La création ne déploie aucun contrat et ne provoque aucune transaction blockchain. L'association `username ↔ wallet_address` est unique et conservée dans `users_usdt_deposit_wallets`.

L'application Android n'a plus besoin de demander l'adresse Wallet personnelle de l'utilisateur, ni de lancer EIP-191 ou WalletConnect pour une recharge. Elle doit afficher l'adresse `deposit_address` renvoyée par `/app/recharge` et indiquer clairement le réseau, le token et le montant exact à envoyer.

### Génération de la branche HD hors ligne

Générer la branche avec un outil local fiable et une phrase de récupération contrôlée par OneX. Exemple avec `ethers.js` v6 exécuté hors ligne sur une machine sécurisée :

```js
const { HDNodeWallet } = require("ethers");

const mnemonic = process.env.ONEX_DEPOSIT_MNEMONIC;
const branch = HDNodeWallet.fromPhrase(
  mnemonic,
  "",
  "m/44'/60'/0'/0",
);

console.log("BSC_DEPOSIT_XPUB=" + branch.neuter().extendedKey);
console.log("BSC_DEPOSIT_XPRV=" + branch.extendedKey);
```

La valeur `BSC_DEPOSIT_XPUB` (clé publique étendue de cette branche) est utilisée par le service HTTP pour dériver les adresses sans détenir les clés privées. La valeur `BSC_DEPOSIT_XPRV` correspondante est nécessaire au service de consolidation pour signer les transferts sortants des adresses de dépôt.

Ne jamais générer la phrase de récupération sur un serveur public, ne jamais la mettre dans le dépôt Git et ne jamais transmettre la phrase ou le `xprv` par e-mail ou messagerie. Sauvegarder la phrase de récupération hors ligne dans un endroit protégé. Une perte de cette phrase peut rendre les fonds irrécupérables.

## 4. Variables d'environnement du serveur HTTP

Copier `.env.example` vers `.env`, puis configurer les valeurs réelles :

```dotenv
USDT_PAYMENTS_ENABLED=true
BSC_RPC_URL=https://your-primary-bsc-rpc-provider
BSC_RPC_FALLBACK_URL=https://your-secondary-bsc-rpc-provider
USDT_BEP20_CONTRACT=0x55d398326f99059fF775485246999027B3197955
USDT_BEP20_EXPECTED_DECIMALS=18
USDT_BEP20_TREASURY_ADDRESS=0xYourOneXTreasuryAddress
BSC_DEPOSIT_XPUB=xpub_of_the_branch_m_44_60_0_0
USDT_MIN_CONFIRMATIONS=15
USDT_PAYMENT_POLL_MS=5000
USDT_MAX_LOG_BLOCK_RANGE=250
USDT_MAX_WALLETS_PER_POLL=25
USDT_SWEEP_ENABLED=false
USDT_SWEEP_IN_MAIN_PROCESS=false
USDT_SWEEP_ENV_FILE=.env.sweeper

SERV_MAIL=your-sender-address
SERV_MAIL_PSWD=your-smtp-app-password
SMTP_HOST=smtp.gmail.com
MAIL_PORT=587
ONEX_SUPPORT_EMAIL=support@your-domain
ONEX_SUPPORT_PHONE=your-support-phone
```

Utiliser des RPC BNB Chain fiables qui autorisent `eth_getLogs` sur les plages de blocs requises. Au démarrage, le backend vérifie notamment le Chain ID, le code du contrat et ses 18 décimales.

Le service HTTP ne doit contenir que le `xpub`, jamais le `xprv` ni la clé privée du portefeuille qui finance le gas. Garder `USDT_SWEEP_IN_MAIN_PROCESS=false`.

## 5. Service de consolidation séparé

La consolidation est exécutée par un processus Node.js distinct, `sweep-worker.js`. Cette séparation permet de ne donner le `xprv` et la clé du portefeuille de gas qu'au processus de consolidation, et non au serveur HTTP public.

1. Copier `.env.sweeper.example` vers `.env.sweeper`.
2. Ajouter dans `.env.sweeper` le `BSC_DEPOSIT_XPRV` correspondant exactement au `BSC_DEPOSIT_XPUB`, et la clé privée d'un portefeuille BNB réservé au financement des frais.
3. Protéger le fichier, par exemple avec `chmod 600 .env.sweeper`, et l'exclure de Git (il est déjà ajouté à `.gitignore`).
4. Lancer le service après que le serveur principal a initialisé les tables :

```bash
npm run sweep
```

Exemple de `.env.sweeper` :

```dotenv
USDT_SWEEP_ENABLED=true
BSC_DEPOSIT_XPRV=xprv_of_the_same_branch_as_the_xpub
BSC_SWEEP_FUNDER_PRIVATE_KEY=0xPrivateKeyOfADedicatedGasWallet
```

Le service utilise également `BSC_RPC_URL`, `BSC_DEPOSIT_XPUB`, le contrat et l'adresse de trésorerie depuis le `.env` principal. Il vérifie une nouvelle fois le réseau 56, le code du contrat et les décimales. `USDT_SWEEP_TOKEN_GAS_LIMIT` (défaut : `100000`) fixe la limite de gas réservée pour le transfert BEP-20 ; elle est configurable entre 60 000 et 200 000. Cette limite fixe évite d'appeler `eth_estimateGas` depuis une adresse de dépôt qui ne possède pas encore de BNB. Le worker finance le gas estimé au tarif courant avec une marge de 10 % ; le gas non consommé reste sur l'adresse de dépôt et pourra servir à une consolidation ultérieure.

Le portefeuille de financement du gas doit être dédié au sweeper et disposer d'un solde BNB suffisant. Le code utilise un verrou MySQL global (`GET_LOCK`) pour éviter que plusieurs instances du worker consomment simultanément les nonces du même portefeuille de gas. Il reste préférable de ne faire tourner qu'une seule instance du worker.

Le service de consolidation calcule, pour chaque adresse utilisateur, le cumul des événements non consolidés. Il déclenche un sweep si :

- le cumul atteint au moins 70 BSC-USD ; **ou**
- le plus ancien transfert non consolidé a au moins 30 jours.

Le sweep transfère vers la trésorerie OneX la somme des événements confirmés inscrits dans le registre jusqu'au bloc de snapshot. Il enregistre les transactions signées et leurs hashes avant diffusion pour permettre une reprise idempotente après redémarrage.

Chaque adresse doit payer le gas de son propre transfert BEP-20. Le worker envoie donc, depuis le portefeuille de gas, juste assez de BNB pour couvrir le transfert avec une marge. La création de l'adresse est gratuite, mais la consolidation ne l'est pas.

Les transferts `pending_support` peuvent également être consolidés vers la trésorerie. Ils restent **non crédités** sur le compte OneX et sont conservés dans le registre de rapprochement pour une décision du support. La consolidation physique ne change pas leur statut de litige ni leur droit éventuel à une régularisation.

## 6. Création d'une commande Android

Endpoint : `POST /app/recharge`

Corps requis :

```json
{
  "user": "USER-PREFIX",
  "pswd": "user-password",
  "amount": "70",
  "tkn": "existing-request-token"
}
```

`amount` doit être une chaîne décimale pour préserver sa précision. L'application ne doit plus envoyer d'adresse source personnelle. Le serveur :

1. authentifie le compte et vérifie son état ;
2. vérifie que le montant demandé est compris entre 70 et 140 ;
3. vérifie que le solde actuel plus le montant ne dépasse pas 300 One-Val ;
4. vérifie la dernière activité `ONEX → utilisateur`, `type=2`, et la période de sept jours ;
5. refuse une nouvelle commande si un paiement est déjà en attente de traitement par le support ;
6. attribue ou récupère l'adresse de dépôt unique du compte ;
7. crée une commande valable 60 minutes.

Réponse acceptée :

```json
{
  "msg": "ok",
  "transf": "pending",
  "request_id": "123",
  "network": "BNB Smart Chain (BEP-20)",
  "chain_id": 56,
  "token_name": "Binance-Peg BSC-USD",
  "token_contract": "0x55d398326f99059fF775485246999027B3197955",
  "decimals": 18,
  "deposit_address": "0x...",
  "receive_address": "0x...",
  "requested_amount": "70.000000000000000000",
  "minimum_amount": "70",
  "maximum_amount": "140",
  "expires_in": 3600
}
```

Une règle métier non satisfaite retourne `{"msg":"not allowed"}`. L'application doit afficher clairement `deposit_address`, le réseau BNB Smart Chain, le contrat approuvé et le montant exact.

## 7. Vérification et traitement des paiements

Le watcher recherche les événements `Transfer(address,address,uint256)` du contrat autorisé dont le destinataire est une adresse de dépôt OneX connue. Il valide le reçu de transaction, le statut, le log correspondant dans le reçu, le bloc canonique et la profondeur de confirmations configurée. Le scanner parcourt les adresses par lots et mémorise le dernier bloc traité de chaque adresse.

Le délai d'une heure est évalué à partir de l'horodatage du bloc qui contient le transfert. Une transaction diffusée par l'utilisateur avant l'expiration mais incluse dans un bloc après l'expiration sera donc considérée comme tardive : le backend ne peut pas prouver de façon fiable l'heure de diffusion depuis le seul événement `Transfer`.

Un transfert est placé dans `pending_support` et n'est pas crédité automatiquement lorsqu'au moins une des conditions suivantes est rencontrée :

- aucune commande antérieure valide ne correspond à l'adresse et à l'heure du transfert ;
- le transfert est inclus après l'expiration de la commande (60 minutes) ;
- la commande a déjà été utilisée ou clôturée ;
- le montant reçu est inférieur à 70 BSC-USD ;
- le montant reçu dépasse 140 BSC-USD ;
- le montant reçu ne correspond pas exactement au montant demandé ;
- le compte a déjà reçu un crédit OneX de type 2 au cours des sept derniers jours ;
- le crédit dépasserait 300 One-Val ;
- le compte n'est pas actif ou la réserve système ne permet pas le crédit.

Les motifs sont enregistrés dans `users_usdt_transfer_events.reason_codes`. Si un compte comporte plusieurs motifs, le courriel les énumère tous. Le système ne doit jamais demander à l'utilisateur de payer une seconde fois avant qu'un agent ait vérifié le premier transfert.

### Statut de la commande

L'application doit interroger `POST /app/recharge/status` avec `user`, `pswd`, `request_id` et `tkn`.

États possibles, selon le traitement : `pending`, `verifying`, `sent`, `completed`, `expired`, `cancelled`, `pending_support` ou `not_found`. Un état `pending_support` signifie que les fonds ont été reçus mais qu'aucun crédit automatique n'a été effectué.

## 8. Notifications e-mail de support

Quand un transfert passe en `pending_support`, le worker de notifications lit l'adresse `auths.email` du compte et utilise Nodemailer avec les variables SMTP existantes (`SERV_MAIL`, `SERV_MAIL_PSWD`, `MAIL_PORT`, et `SMTP_HOST`). Le courriel contient :

- le ou les motifs exacts de la mise en attente ;
- le montant reçu et l'adresse de dépôt ;
- l'adresse expéditrice observée ;
- le hash de transaction et la date du bloc ;
- la consigne de contacter OneX par e-mail ou téléphone ;
- les coordonnées `ONEX_SUPPORT_EMAIL` et `ONEX_SUPPORT_PHONE`.

Les échecs d'envoi sont retentés avec un délai, jusqu'à cinq tentatives. Si `auths.email` est absent ou invalide, l'échec est journalisé et l'état d'e-mail passe à `failed` ; aucune livraison e-mail n'est possible sans adresse valide.

Les cas `pending_support` bloquent une nouvelle commande de recharge sur le même compte jusqu'à leur résolution. La résolution doit être effectuée par le support après vérification dans le registre des événements. Le présent paquet n'ajoute pas d'interface d'administration de résolution des litiges.

## 9. Schéma MySQL et migrations

Au démarrage, `db.js` crée les tables et index nécessaires, en convertissant les tables concernées vers InnoDB si nécessaire.

- `users_usdt_tx` : commandes de recharge et leur état ; elle est migrée pour accepter plusieurs commandes historiques par utilisateur.
- `users_usdt_recharge_status` : état et réponse exposés à l'application.
- `users_usdt_deposit_wallets` : association unique du compte à son adresse et à son index de dérivation.
- `users_usdt_transfer_events` : journal idempotent des événements blockchain, motifs d'attente, état des notifications et consolidation.
- `users_usdt_sweeps` : opérations de consolidation, transactions signées, hashes, statut et erreurs.
- `system_locks` : sérialisation de l'attribution des index d'adresses et des opérations comptables.

Les anciens enregistrements `users_usdt_tx` du modèle à adresse de réception unique sont marqués `legacy_untracked` s'ils ne correspondent pas à une adresse du nouveau registre. Ils ne sont pas supprimés.

L'index `idx_activities_recharge_user` permet de rechercher rapidement le dernier crédit OneX de type 2. Une date historique invalide bloque la recharge plutôt que de contourner la limite hebdomadaire.

## 10. Comptabilisation OneX

Après validation, le watcher appelle directement la fonction interne de crédit dans une transaction SQL ; aucun appel HTTP interne à la route admin n'est effectué.

- `users_stock.balance` augmente directement du montant BSC-USD reçu, exprimé en One-Val ;
- `activities.amount` conserve la convention historique des actifs initiaux : `montant reçu / unit_price` ;
- `activities.unit_price` conserve le prix enregistré au moment du crédit ;
- les valeurs de `common` sont mises à jour selon les conventions comptables existantes ;
- l'activité, le solde, `common`, le hash et l'état de recharge sont validés atomiquement.

Les crédits manuels d'administrateur conservent leur montant libre en One-Val (ils ne sont pas limités à 70–140 BSC-USD), mais un crédit `type=2` est pris en compte par le contrôle de sept jours.

## 11. Déploiement

1. Faire une sauvegarde complète de MySQL et des fichiers `.env`.
2. Installer les dépendances : `npm install`.
3. Configurer le `.env` HTTP avec les RPC, la trésorerie, le `xpub`, SMTP et les coordonnées du support.
4. Laisser `USDT_SWEEP_ENABLED=false` dans le `.env` HTTP.
5. Faire démarrer le serveur principal : `npm start`. Il initialise le schéma et démarre le watcher des paiements.
6. Configurer `.env.sweeper` sur l'hôte du worker seulement, avec le `xprv` et la clé privée du portefeuille gas ; démarrer `npm run sweep` avec un gestionnaire de processus (systemd, PM2 ou équivalent).
7. Vérifier les journaux du scanner, du mailer et du sweeper.
8. Réaliser d'abord des transactions de test contrôlées avant d'ouvrir les paiements en production.

La commande `npm run check` vérifie la syntaxe JavaScript des fichiers, pas l'intégration en production. Un test bout en bout nécessite une base MySQL réelle, un RPC BSC autorisé pour `eth_getLogs`, une configuration SMTP fonctionnelle et des transactions de test.

## 12. Précautions importantes

- Le `xprv` contrôle toutes les clés privées dérivées et donc les fonds déposés sur toutes les adresses. Il doit rester dans le service de consolidation et être sauvegardé hors ligne.
- La clé privée du portefeuille de gas doit appartenir à un portefeuille dédié au sweeper et ne doit pas servir à d'autres transactions concurrentes.
- Le portefeuille principal de trésorerie et le portefeuille de gas doivent être distincts de préférence.
- Une consolidation regroupe physiquement les tokens mais ne modifie pas le statut comptable ni le statut `pending_support` d'un paiement.
- Les paiements depuis des plateformes d'échange peuvent utiliser des adresses d'expéditeur mutualisées ; comme l'adresse de dépôt est unique par compte, le backend attribue le paiement au compte correspondant à l'adresse destinataire, mais les règles d'une plateforme d'échange peuvent empêcher l'utilisateur de contrôler la source affichée.
- La valeur 300 dans `maxDefaultStock` et le bonus de bienvenue doivent être cohérents : un utilisateur dont le solde atteint déjà 300 One-Val ne pourra pas recevoir de recharge supplémentaire.

## 13. P2P pricing basis and UTC timestamps

`users_stock` now has `init_asset VARCHAR(255) NOT NULL DEFAULT '0'`. The
account-specific P2P unit price is derived at transaction time as:

`priceValue = sender.users_stock.balance / sender.users_stock.init_asset`

The `/app/near-transfer` transaction locks and reads the sender, destination,
and system stock rows including `init_asset`. It no longer queries
`activities.unit_price` to determine the sender's price. It writes the derived
`priceValue` to `activities.unit_price` and recalculates each affected account's
`init_asset` as its resulting balance divided by `priceValue`. The system stock
basis is also recalculated because its balance changes when it receives the
system fee share, or participates as sender/receiver.

All other stock-changing paths maintain the same invariant:

- Welcome bonus: `init_asset = resulting_balance / 1`, matching its activity
  unit price of 1.
- Automatic BEP-20 top-up and administrative user top-up: `init_asset =
  resulting_balance / common.unit_price` used for the corresponding activity.
- P2P sender, recipient, and system fee account: `init_asset =
  resulting_balance / priceValue`.

On startup, the database migration adds the column when missing. For every
legacy account with a positive balance and `init_asset` equal to zero, it uses
the latest positive `common.unit_price` as a one-time common starting basis:
`init_asset = balance / common.unit_price`. It deliberately does not use
historical `activities.unit_price` values because those values may contain the
stale per-sender pricing that this change is intended to remove. If a positive
balance cannot be backfilled because the common price is not valid, startup
stops with an explicit error. Zero-balance accounts retain `init_asset = 0`.

All new `record_date` and `record_time` values are now formatted explicitly
with UTC getters (GMT+0), independently of the host's local timezone. Node
entrypoints set `TZ=UTC`, MySQL connections use the UTC driver timezone and
execute `SET time_zone = '+00:00'`. Existing historical date/time values are
not rewritten by this migration. The current code's date helper was already
requesting UTC through Moment; the change makes the UTC behavior explicit and
removes the Moment dependency from date generation.

Run `npm test` after installing dependencies. It performs JavaScript syntax
checks and unit tests for the `balance / init_asset` and resulting
`balance / priceValue` calculations. A production integration test still
requires the actual MySQL database and application configuration.

## 14. Adresse de dépôt dans `/app/user-last-stock`

La réponse de `POST /app/user-last-stock` contient maintenant trois champs :

```json
{
  "msg": 125.5,
  "fees": 25,
  "deposit_addr": "0x..."
}
```

`deposit_addr` est l'adresse BEP-20 unique associée au `username` dans `users_usdt_deposit_wallets`. Si l'adresse n'existe pas encore et que le fournisseur de paiement est activé, le backend la crée à la demande avec le mécanisme HD Wallet déjà utilisé par `/app/recharge`. La création est protégée par les verrous SQL et les index uniques existants.

Si une adresse existe déjà, elle est renvoyée sans appel RPC supplémentaire. Si les paiements BEP-20 sont désactivés et qu'aucune adresse n'a encore été attribuée, `deposit_addr` vaut `null`; le solde et les frais restent disponibles. En cas d'erreur DB/RPC pendant l'attribution, la route retourne `{"msg":"error"}` au lieu de retourner une adresse inventée ou incomplète.

L'application Android peut afficher `deposit_addr` comme adresse de dépôt permanente. La demande de recharge et son délai d'une heure doivent néanmoins continuer à être créés via `/app/recharge` avant que l'utilisateur n'envoie les tokens.

## 7. Vente d'One-Val au système et disbursement BSC-USD

La vente au système utilise toujours `POST /app/near-transfer`, avec `dest="ONEX"`. Cette branche est distincte du transfert P2P classique : le compte système n'est pas traité comme expéditeur par cette route. Les transferts P2P ordinaires restent réservés aux deux comptes utilisateurs. `P2P_ALLOWED` désactive uniquement les transferts entre utilisateurs ; les ventes vers `ONEX` sont contrôlées par `USDT_DISBURSEMENTS_ENABLED`.

Conditions appliquées lors de la demande :

- Le compte doit être actif et le mot de passe doit être valide.
- Le solde One-Val de l'utilisateur doit être au moins égal à `maxDefaultStock - 10` (soit 290 One-Val avec le plafond actuel de 300).
- Une demande est autorisée par période glissante de 30 jours par utilisateur.
- L'adresse de réception BSC-USD doit être présente dans `users_usdt_deposit_wallets.payout_address`.
- Le montant envoyé par l'application dans `amount` est le versement net BSC-USD attendu, calculé par le serveur, et non le solde brut. Il doit correspondre au paiement net calculé par le serveur, avec une tolérance maximale de `0.00000001`.
- Le taux `FEES` est supporté entièrement par le vendeur. Le paiement net est calculé à `balance × (100 - FEES) / 100` BSC-USD, arrondi à 18 décimales vers le bas. La différence est enregistrée comme frais. Exemple avec 300 One-Val et `FEES=3` : versement net de 291 BSC-USD et frais de 9 One-Val.

La demande réserve le solde de l'utilisateur en le ramenant à zéro dans la même transaction SQL que la création du job. Elle ne met pas immédiatement à jour `common` : les changements comptables ne sont validés qu'après confirmation on-chain du transfert BSC-USD depuis le portefeuille principal OneX. Si la transaction sortante est minée avec un statut d'échec, le solde utilisateur est restauré automatiquement lorsque cela peut être fait sans écraser une modification concurrente. Si le résultat est ambigu, le job est placé en `manual_review` et le solde reste réservé jusqu'à intervention du support.

Après confirmation du versement, le worker :

1. crédite le stock interne `ONEX` du montant One-Val brut liquidé ;
2. ajoute à `common.inactive_init_asset` la base initiale correspondant à la vente nette (payout BSC-USD / `priceValue`), sans y inclure les frais retenus ;
3. déduit de `common.total_units_price` le montant BSC-USD réellement envoyé (équivalence comptable 1 BSC-USD = 1 One-Val) ; les frais à la charge du vendeur restent séparés et sont enregistrés dans `activities.fees` ;
4. conserve `common.unit_price` et `common.backed_units` inchangés ;
5. inscrit une activité de vente de type `3`, de l'utilisateur vers `ONEX`.

Lors des recharges utilisateur ultérieures, `applyUserTopUp()` consomme d'abord `common.inactive_init_asset`, puis `common.backed_units` uniquement pour le reliquat. La disponibilité totale utilisée pour accepter un crédit est donc `(inactive_init_asset + backed_units) × unit_price`. Si les seuls actifs inactifs suffisent, le prix reste inchangé. Si des actifs adossés doivent être utilisés, la formule historique d'évolution du prix est appliquée sur le montant complet de la recharge. Le montant complet de la recharge est ajouté à `common.total_units_price` dans les deux cas.

### Adresse de versement

`users_usdt_deposit_wallets.payout_address` est initialisée, si elle est encore vide, à partir de l'adresse `from` d'une première recharge reçue par un transfert BEP-20 direct (`transfer()` initié par la même adresse). Elle n'est jamais remplacée automatiquement. Cette règle ne prouve pas qu'une adresse d'exchange ou de portefeuille custodial appartient personnellement à l'utilisateur : les dépôts depuis des plateformes centralisées peuvent être refusés pour l'enregistrement du Wallet de versement ou nécessiter une procédure de vérification séparée. L'utilisateur doit être informé que les remboursements seront envoyés à cette adresse de versement enregistrée.

### Worker de disbursement

Le disbursement est signé par un processus séparé ; la clé privée du portefeuille principal ne doit pas être chargée dans le processus HTTP.

1. Copier `.env.disbursement.example` vers `.env.disbursement`.
2. Y renseigner `BSC_DISBURSEMENT_PRIVATE_KEY`, qui doit correspondre exactement à `USDT_BEP20_TREASURY_ADDRESS`.
3. Protéger le fichier (`chmod 600 .env.disbursement`) et ne jamais le committer.
4. Dans `.env`, activer `USDT_PAYMENTS_ENABLED=true` et `USDT_DISBURSEMENTS_ENABLED=true`, configurer le RPC BSC, le contrat autorisé et l'adresse de trésorerie.
5. Démarrer le processus dédié :

```bash
npm run disburse
```

Le portefeuille de trésorerie doit avoir un solde BSC-USD suffisant pour les versements et un solde BNB suffisant pour le gas. Ne pas utiliser ce même compte pour des transactions sortantes concurrentes non gérées par le worker : le worker réserve des nonces auprès du RPC mais ne peut pas coordonner les transactions émises par des logiciels externes.

Valeurs principales configurables :

```dotenv
USDT_DISBURSEMENTS_ENABLED=true
USDT_DISBURSEMENT_ENV_FILE=.env.disbursement
USDT_DISBURSEMENT_POLL_MS=3000
USDT_DISBURSEMENT_CONFIRMATIONS=15
USDT_DISBURSEMENT_GAS_LIMIT=100000
```

L'endpoint `POST /app/disbursement/status` permet au compte authentifié de consulter l'état d'un job à partir de son `disbursement_id`. Les états `queued`, `signed` et `submitted` signifient que le paiement n'est pas encore confirmé. `confirmed` signifie que le receipt du contrat autorisé contient l'événement `Transfer` exact attendu et que le nombre de confirmations configuré est atteint. `manual_review` requiert une action du support.

La limite mensuelle est une période glissante de 30 jours (et non un mois calendaire). Une demande créée, même si elle échoue ultérieurement, compte dans cette limite afin d'empêcher la répétition automatique de demandes.
