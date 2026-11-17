# OneX — schéma cible et règles comptables en actifs initiaux

## Statut du schéma

Cette version définit le schéma cible pour une première mise en production. Elle ne migre pas les anciennes tables et ne convertit pas les anciens soldes. Créer une base MySQL neuve et vide. `db.js` crée les tables, vérifie les colonnes et valide le prix global au démarrage. Une ancienne structure qui ne correspond pas au schéma cible provoque une erreur explicite; ne pas la réutiliser sans une migration distincte, auditée et sauvegardée.

Par défaut, une nouvelle base initialise `common.total_units_price=10000000`, `common.backed_units=10000000`, et donc `common.unit_price=1`. `STOCK_LIMIT` et `INITIAL_BACKED_UNITS` règlent les valeurs initiales. La quantité d'actifs déclarée doit correspondre aux actifs réellement détenus. `INITIAL_BACKED_UNITS` doit couvrir le quota administratif initial de 10 %.

## Convention d'unités

- Réseau : BNB Smart Chain mainnet, chain ID 56.
- Token de règlement : Binance-Peg BSC-USD (BEP-20), contrat `0x55d398326f99059fF775485246999027B3197955`, 18 décimales. Il ne s'agit pas d'un USDt émis directement par Tether.
- **Tous les soldes et réserves internes sont enregistrés en actifs initiaux.** Cela comprend `users_stock.balance`, `users_stock.run_balance`, `users_stock.pending_bonus`, `common.backed_units`, `common.inactive_init_asset`, `common.sys_inactive_init_asset`, `common.sellers_res` et `common.total_run_balance`.
- `common.total_units_price` est la seule valeur de stock persistée en XTU.
- Le seul prix courant du système est `common.unit_price`, en XTU par actif initial :

```text
common.unit_price = common.total_units_price / common.backed_units
user_balance_xtu = users_stock.balance * common.unit_price
initial_asset_amount = requested_xtu / common.unit_price
```

- `common.backed_units` est consommable au-dessus du quota administratif restant et reste intégralement le dénominateur de la formule de prix. Les 10 % administratifs ne sont donc pas exclus de la valorisation : ils sont inclus dans `backed_units` et participent au prix, mais ne sont pas disponibles aux opérations ordinaires tant qu'ils n'ont pas été dépensés par l'administration.
- Aucune valeur de solde XTU n'est stockée dans une table utilisateur, vendeur ou réserve. Les champs de prix dans les campagnes, lots vendeurs, allocations de paiement et demandes de disbursement sont des **instantanés historiques immuables** nécessaires pour conserver le prix contractuel de soumission; ils ne sont pas des prix courants individuels.
- `activities.amount` et `activities.fees` sont en actifs initiaux. `activities.unit_price` conserve le prix global au moment de l'activité; la valeur historique en XTU est `amount * unit_price` et `fees * unit_price`.
- Les montants réellement dus ou transférés en BSC-USD restent en BSC-USD; les coûts de gas restent en BNB et leurs équivalents restent en BSC-USD.
- Toutes les opérations monétaires utilisent `BigNumber`, jamais des nombres flottants JavaScript. Toutes les dates et heures nouvelles sont en UTC.

## Prix global et mises à jour `common`

Toute opération qui modifie `common.total_units_price` ou `common.backed_units` doit prendre le verrou SQL `common_state` et créer un snapshot par `insertCommonSnapshotTx()`. Celui-ci recalcule `common.unit_price = total_units_price / backed_units`. `getLatestCommonTx()` vérifie la relation avant toute opération financière. `total_units_price` et `backed_units` doivent rester strictement positifs pour que le prix reste défini.

Les conversions utilisateur utilisent le prix global lu et verrouillé au début de l'opération financière. Une variation ultérieure du prix courant ne modifie pas rétroactivement les soldes initiaux.

## Réserve administrative 10/90

Le quota initial est fixe et calculé sur `STOCK_LIMIT`, pas sur le `total_units_price` fluctuant :

```text
initial_admin_quota = STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO
remaining_admin_quota = initial_admin_quota - common.sys_inactive_init_asset
ordinary_backed_available = common.backed_units - remaining_admin_quota
ordinary_reserve_available = common.inactive_init_asset + ordinary_backed_available
```

`SYSTEM_ADMIN_RESERVE_RATIO` vaut 0.10 par défaut. Pour `STOCK_LIMIT=10,000,000`, le quota administratif initial est de 1,000,000 actifs initiaux et la capacité distribuable initiale est de 9,000,000. Les 1,000,000 sont déjà compris dans `backed_units` et continuent à participer à `unit_price`. Les recharges et ventes ordinaires peuvent consommer `inactive_init_asset` et la partie de `backed_units` supérieure au quota administratif restant.

`common.sys_inactive_init_asset` est un compteur cumulatif des actifs initiaux déjà dépensés par l'administration; il n'est pas une réserve dépensable. Lorsqu'une dépense administrative de `amount` XTU est enregistrée, le prix courant est figé avant l'opération :

```text
spent_initial_asset = amount / current_unit_price
total_units_price_after = total_units_price_before - amount
backed_units_after = backed_units_before - spent_initial_asset
sys_inactive_init_asset_after = sys_inactive_init_asset_before + spent_initial_asset
unit_price_after = total_units_price_after / backed_units_after
```

Le numérateur et le dénominateur diminuent proportionnellement : le prix est donc conservé, à la précision SQL. Le reliquat administratif diminue du même montant initial dépensé. Le serveur refuse une dépense supérieure au quota disponible, une réserve négative ou une valeur `backed_units` nulle.

## Recharges et dépôts

Chaque compte possède une adresse individuelle de dépôt BSC-USD. Les dépôts finalisés sont identifiés par transaction hash et log index puis regroupés pendant 60 minutes; un batch peut contenir plusieurs transferts.

- Minimum automatique : 12 BSC-USD par batch.
- Maximum de 140 BSC-USD et cooldown de sept jours : uniquement pour la part financée par les réserves système ONEX.
- Les montants financés par la réserve vendeurs ne sont pas soumis à cette restriction hebdomadaire.
- Le solde public après crédit ne peut pas dépasser 300 XTU; le contrôle multiplie le nouveau solde initial par le prix global résultant de l'opération.
- `net = gross_received - tfees - configured_BSC_gas_recovery`. La récupération concerne le gas d'opérations sortantes payées par OneX; le gas déjà payé par le déposant ne doit pas être refacturé.
- Ordre de financement : réserve vendeurs FIFO (`common.sellers_res`), puis `common.inactive_init_asset`, puis `common.backed_units` au-dessus du quota administratif restant.
- La part financée par les vendeurs est un transfert d'actifs initiaux du lot vendeur vers le compte bénéficiaire; elle ne crée pas une deuxième fois ces actifs.
- La part financée par ONEX convertit le net XTU en actifs initiaux au prix global courant verrouillé au début de la transaction. Les réserves sont ensuite mises à jour et le prix global est recalculé par le ratio commun.
- Si l'utilisateur est sous cooldown et que la réserve vendeurs ne couvre pas intégralement le net, aucun crédit partiel n'est effectué. Le batch est mis en attente et réévalué périodiquement.
- Le seuil de 70 BSC-USD concerne le sweep des dépôts vers le treasury, pas le minimum de recharge; les dépôts non balayés peuvent aussi être consolidés après 30 jours.

Les transactions en attente de disbursement doivent être protégées contre l'utilisation concurrente de la réserve système par les recharges. Le contrôle de disponibilité tient donc compte des montants initialement réservés par les demandes non résolues.

## Campagnes vendeurs et paiements figés

`POST /app/join-system-sellers` reçoit `run_balance` en XTU. Sous verrou `common_state`, la route capture le `common.unit_price` courant et convertit le montant en actifs initiaux. Le solde, `run_balance`, `pending_bonus`, le total des campagnes (`common.total_run_balance`), `common.sellers_res` et les lots sont stockés en actifs initiaux. Les seuils publics de 12 XTU, le verrouillage d'au moins 50 % et le bonus d'au moins 10 % sont vérifiés à partir du même prix de soumission.

Lors de l'activation, 50 % de `run_balance` (hors bonus) est réservé dans `common.sellers_res`; le solde principal n'est pas diminué uniquement parce que le vendeur rejoint la campagne. Pendant la campagne, la limite P2P est calculée en actifs initiaux : `balance - 0.5 * run_balance`. Les lots sont consommés en FIFO; la consommation débite le solde initial du vendeur et crée une dette de paiement.

**Le prix de paiement vendeur est figé lors de la soumission de sa campagne** (`/app/join-system-sellers`). Chaque lot conserve ce prix. Le montant BSC-USD dû est calculé à partir des actifs initiaux consommés multipliés par le prix figé du lot; un changement ultérieur de `common.unit_price` ne modifie pas cette dette. Les paiements sont regroupés par vendeur, en lots d'au plus 300 BSC-USD brut. Le worker envoie le montant déjà enregistré, ne le recalcule pas au prix courant et déduit uniquement le gas BSC estimé; aucun `tfees` n'est appliqué au vendeur prioritaire.

Les campagnes expirent après sept jours. Une demande d'annulation ne libère pas les actifs non consommés avant le déverrouillage administratif ou l'expiration normale. Les actifs vendus restent une dette jusqu'au paiement confirmé. `common.total_run_balance` est le cumul des références de campagnes actives, en actifs initiaux.

Le bonus demeure incomplet : `pending_bonus` est stocké en actifs initiaux et son seuil d'éligibilité est contrôlé, mais son origine, son calcul, son accumulation et son crédit automatique ne sont pas implémentés tant que ces règles n'ont pas été définies.

## Transferts P2P et frais

`POST /app/near-transfer` reçoit un montant public XTU. Le prix global unique est lu sous le verrou `common_state`, puis le montant est converti en actifs initiaux. L'expéditeur est débité du montant brut initial; le destinataire reçoit le montant initial net après déduction de la totalité des `tfees`. Le destinataire supporte les frais; aucun gas BSC n'est appliqué aux transferts P2P.

La base initiale complète des `tfees` est conservée par OneX et ajoutée à `common.backed_units`; sa valeur XTU au prix de l'opération augmente `common.total_units_price`. `common.total_tfees` est un compteur cumulatif en actifs initiaux et ne diminue jamais. Il n'existe aucune séparation CommonShare/AdminFees ni transfert vers un portefeuille dédié aux frais.

## Vente à ONEX et disbursement

Une vente à ONEX exige une valeur publique d'au moins 290 XTU, une adresse BSC-USD enregistrée, aucune demande non résolue et un cooldown de 90 jours après une vente confirmée. Le solde complet de l'utilisateur est réservé en actifs initiaux. Lors de la soumission, la route capture `common.unit_price`, calcule les frais et le paiement BSC-USD, puis enregistre `price_value`, `gross_initial_asset`, `sold_initial_asset`, `fee_initial_asset`, `fee_amount`, `payout_amount` et `amount_raw`.

**Le prix de disbursement est figé au moment où l'utilisateur soumet la demande**, pas au moment où le worker paie. Le worker utilise exclusivement les valeurs persistées et ne les réévalue pas au prix global courant. Après transfert BSC-USD confirmé et finalisé, le système applique la sortie au common stock selon le payout et les bases initiaux figés; il calcule ensuite le nouveau prix global pour les opérations suivantes. Une opération échouée ne restaure le solde réservé qu'après vérification de canonicalité/finalité et de la profondeur de confirmations configurée.

Les demandes non résolues sont réservées en actifs initiaux et soustraites de la capacité distribuable pour empêcher les recharges d'utiliser les mêmes actifs avant le paiement. Une campagne vendeur active ou en annulation en attente interdit la vente complète à ONEX.

## Historique et frais

`activities.amount` et `activities.fees` sont des actifs initiaux. `activities.unit_price` est le prix global figé à l'opération. L'API d'historique expose les montants internes et calcule aussi les équivalents XTU historiques avec ce prix, jamais avec le prix courant.

`common.total_tfees` est le cumul historique des frais retenus, en actifs initiaux. Les frais BNB sont distincts : `total_bnb_fee_estimated` et `total_bnb_fee_actual` sont en BNB; leurs champs `_value` sont des équivalents BSC-USD capturés. Le gas réel est calculé par `gasUsed * effectiveGasPrice` et journalisé une seule fois dans `bsc_fee_ledger` après finalité.

Les remboursements n'appliquent aucun `tfees`; seule la récupération configurée du gas BSC supporté par OneX est déduite. Le minimum de remboursement net reste 10 BSC-USD.

## Routes administratives de stock

- `POST /admin/update-user-stock` crédite un utilisateur via le même allocateur qu'une recharge. `amount` est une valeur publique XTU/BSC-USD convertie au prix global courant; la priorité vendeurs, le cooldown et plafond ONEX, la limite utilisateur, les `tfees` et la récupération des coûts BSC restent actifs. Seul le minimum automatique est contourné.
- `POST /admin/update-common-stock` réalise exclusivement une dépense administrative. `amount` est XTU; la route la convertit au prix global courant puis diminue `total_units_price` et `backed_units` proportionnellement. Les actifs initiaux dépensés sont ajoutés au compteur cumulatif `sys_inactive_init_asset`. Cette opération ne crédite pas un utilisateur et n'est ni un rachat ni une émission.

## Déploiement et frais généraux

`BNB_USD_PRICE` doit être une cotation BNB/USD positive capturée avant l'activation des workers BSC. Les frais BNB estimés et réels restent distincts et sont conservés dans `bsc_fee_ledger`. Les clés privées restent dans les fichiers d'environnement dédiés aux workers; ne jamais distribuer de vrais fichiers `.env`.

## Telegram et SMTP

Telegram est facultatif. `/app/signin` renvoie `tg_botLink`; l'association se fait dans une conversation privée avec un token temporaire de dix minutes. Un seul worker `npm run telegram` doit exécuter le long polling. Les messages transactionnels sont en anglais et envoyés via `telegram_outbox`, uniquement lorsque le compte est associé. La file offre une livraison au moins une fois; un doublon reste possible après arrêt du worker entre l'envoi et l'enregistrement du statut `sent`.

SMTP reste réservé à l'inscription, la récupération de compte, `/app/contact-onex` et au flux administratif de vérification d'identité déjà existant. Les notifications transactionnelles ne sont pas envoyées par email. `notifs`, `/app/feed` et `/admin/add-to-feed` restent supprimés.

## Secrets et workers

Les fichiers `.env` réels ne doivent jamais être distribués. Fournir uniquement `.env.example`, `.env.sweeper.example` et `.env.disbursement.example`.

- HTTP + scanner : aucune clé privée de wallet.
- `npm run sweep` : clé HD des adresses de dépôt et clé du financeur gas dans `.env.sweeper`.
- `npm run disburse` : clé du treasury dans `.env.disbursement`; les flags opérationnels et `BNB_USD_PRICE` viennent du `.env` principal. Le worker traite uniquement les disbursements, remboursements et paiements vendeurs.
- Le worker de cycle de vie vendeur et de préparation des lots de paiement est lancé par `npm start`; il nécessite uniquement la base de données, sans clé privée. Il utilise un verrou MySQL pour éviter le double traitement.

## Authentification et récupération

- Après trois mots de passe incorrects, le compte est verrouillé pour l'authentification par mot de passe permanent.
- La récupération par seed ou l'émission administrative envoie par SMTP un mot de passe temporaire de sept chiffres, valable dix minutes.
- La connexion avec un mot de passe temporaire remet le compteur d'échecs à zéro, mais les activités protégées restent bloquées jusqu'à modification du mot de passe temporaire en mot de passe permanent.
- Un mot de passe temporaire expiré ne débloque pas les activités.

## Vérifications et limites

- `npm run check` : contrôle de syntaxe des fichiers JavaScript.
- `npm test` : tests unitaires des politiques et fonctions comptables.
- Les tests unitaires ne remplacent pas les tests d'intégration sur une base MySQL neuve, le testnet BSC, les tests SMTP/Telegram et la répétition des scénarios de reprise après redémarrage.
- Bonus : aucune génération, accumulation ou formule de crédit n'est implémentée dans cette version.

## API hardening update (2026-11-15)

The HTTP layer now applies an IP-based global limit (default 180 requests / 60 seconds) and stricter windows for sensitive routes. The limiter runs before request-body parsing. Normal request bodies are limited to 256kb; `/app/signup` has a dedicated 10mb parser for base64 identity images, with each supplied image limited to 3mb decoded. Signup input lengths are validated before Argon2 hashing and username allocation retries stop after ten collisions.

The new MySQL tables `account_security_action_locks`, `account_security_events` and `account_api_rate_limits` persist and serialize account-level quotas. Password and seed changes allow three recorded failures plus one successful change in a rolling 24-hour period. A fourth failed attempt is rejected with `{ "auth": "limit reached" }`; the one successful change remains available even after the three failed attempts. Account recovery allows two requests in 24 hours and counts each syntactically valid request before checking the seed. The third returns the same `auth` limit response. Cleanup removes security events after eight days and rate buckets after two days.

Authenticated per-account request limits additionally protect expensive reads and write operations. SMTP sends now pass through a bounded in-process queue (30 messages/hour, 50 queued, concurrency 2, up to 2 attempts by default). Pending mail jobs are not persisted across a process restart.

`multipleStatements` is disabled. SQL values remain parameterized; dynamic SQL identifiers are taken only from internal fixed allowlists. The database pool defaults to 20 connections and 100 queued requests. Argon2's queue defaults to 20 waiters with a 15-second queue timeout. `TRUST_PROXY_HOPS` defaults to zero; set it only to the exact trusted proxy count. Optional HTTPS enforcement uses `FORCE_HTTPS` and a configured `PUBLIC_HTTPS_ORIGIN`.

Transaction history is restricted to a rolling window of at most 30 days; because activity timestamps are stored to whole seconds, the cutoff is rounded upward to avoid including an older second and cursor-paginated (50 rows by default, maximum 100). The response retains `trans` and adds `days`, `limit` and `next_before_id`; the client sends `next_before_id` back as `before_id`.

These changes add three tables and four activity-history indexes. The project still expects the current schema. `CREATE TABLE IF NOT EXISTS` creates the new security tables, but an existing `activities` table will not automatically gain the new indexes. For an existing database, inspect `SHOW INDEX FROM activities` and apply only the missing indexes (do not add duplicate indexes):

```sql
ALTER TABLE activities
  ADD INDEX idx_activities_sender_id (sender, id),
  ADD INDEX idx_activities_receiver_id (receiver, id),
  ADD INDEX idx_activities_history_sender (sender, record_date, record_time, id),
  ADD INDEX idx_activities_history_receiver (receiver, record_date, record_time, id);
```

This combined statement is for a table missing all four indexes. If only some are missing, create only those individual indexes. Index creation on a large production table can consume I/O and may affect writes; back up first and schedule it during a maintenance window. Startup checks that all four indexes exist and aborts rather than silently running the unindexed history query.


## Additional API security hardening

- The 24-hour password-change and seed-change quotas are checked and recorded in MySQL under account-specific locks. Argon2 verification and new-secret hashing are performed before opening the write transaction; the transaction then locks and re-checks the credential hash and current lock state before recording the result. This limits lock duration without allowing a stale password snapshot to overwrite a newer credential.
- Signup payload size is separately parsed, with a hard maximum of 10 MiB regardless of environment configuration; each supplied identity image is separately capped at 3 MiB after decoding. Normal request bodies remain capped at 256 KiB.
- Financial amount strings accepted directly from HTTP requests are length-capped before BigNumber parsing. This does not change XTU accounting formulas or transaction fee calculations.
- The HTTP limiter applies route-specific IP windows to sensitive read, write, download and administrative endpoints. It normalizes route casing and trailing slashes. The limiter is process-local; multi-instance deployments must enforce the same or stricter IP policy at the shared reverse proxy/API gateway.
- MySQL sessions use a bounded InnoDB row-lock wait timeout. Existing transaction logic and financial write ordering are unchanged.
- The transaction-history endpoint accepts at most 30 days. A larger `days` value is clamped to 30, while invalid or fractional values are rejected. Existing `trans` payload format is preserved and cursor pagination is additive.
