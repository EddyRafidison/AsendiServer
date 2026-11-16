# OneX — schéma cible et règles de première mise en production

## Statut du schéma

Cette version est destinée à un projet OneX non encore déployé. Elle définit directement le schéma cible. Elle ne migre pas et ne remplit pas les anciennes tables. Créer une base MySQL neuve et vide. `db.js` crée les tables avec `CREATE TABLE IF NOT EXISTS`, puis vérifie les colonnes requises. Une ancienne structure ne correspondant pas au schéma cible provoque volontairement une erreur au démarrage.

Par défaut, une nouvelle base initialise `common.total_units_price=10000000`, `common.unit_price=1` et `common.backed_units=10000000`. `STOCK_LIMIT` et `INITIAL_BACKED_UNITS` peuvent remplacer ces valeurs; `INITIAL_BACKED_UNITS` prend par défaut la valeur de `STOCK_LIMIT` et ne peut pas la dépasser. La réserve déclarée doit correspondre aux actifs réellement disponibles. La réserve administrative initiale non distribuable est fixée à `STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO` (10 % par défaut). Les 90 % restants constituent la capacité initiale distribuable, sous réserve des soldes réellement adossés.

## Conventions comptables

- Réseau : BNB Smart Chain mainnet, chain ID 56.
- Token : Binance-Peg BSC-USD, contrat `0x55d398326f99059fF775485246999027B3197955`, 18 décimales. Ce n'est pas un USDt directement émis par Tether.
- Équivalence opérationnelle : 1 XTU = 1 BSC-USD.
- `users_stock.balance` : solde XTU direct.
- `users_stock.init_asset` : base en actifs initiaux.
- `users_stock` ne possède pas de `unit_price` individuel.
- `activities.amount` et `activities.fees` suivent la dénomination définie par l'opération; `activities.unit_price` enregistre le prix de conversion utilisé.
- `common.total_units_price` : valeur en XTU.
- `common.backed_units`, `common.inactive_init_asset`, `common.sys_inactive_init_asset` et `common.sellers_init_asset` : actifs initiaux.
- `common.sellers_res` : XTU réservé aux vendeurs.
- Les calculs financiers utilisent `BigNumber`, jamais l'arithmétique flottante JavaScript.
- Toutes les dates et heures nouvellement écrites par le serveur sont en UTC.

## Recharges et dépôts

Chaque compte possède une adresse individuelle de dépôt BSC-USD. Le scanner détecte les événements `Transfer` finalisés, attribue le paiement à l'adresse du compte et ouvre automatiquement un batch. Les transferts sont identifiés par transaction hash et log index. Un batch regroupe tous les transferts reçus pendant les 60 minutes suivant le premier événement finalisé; aucun maximum arbitraire de deux transferts ne s'applique.

Règles de montant :

- Minimum automatique : 12 BSC-USD par batch.
- Maximum 140 BSC-USD et cooldown de sept jours : uniquement pour la portion financée par les réserves système ONEX.
- Les montants financés par la réserve vendeurs ne sont pas soumis à cette limite hebdomadaire.
- Le solde de l'utilisateur après crédit ne peut pas dépasser 300 XTU.
- Le seuil de 70 BSC-USD concerne la consolidation d'une adresse de dépôt vers le treasury, pas le minimum de recharge.

Le montant crédité est :

`net = brut reçu - tfees - récupération estimée des frais BSC assumés par OneX`

La récupération BSC est configurable par `RECHARGE_BSC_FEE_RECOVERY_USD`. Elle concerne uniquement les opérations sortantes payées par OneX (par exemple la consolidation). Le gas payé par l'utilisateur pour envoyer son dépôt n'est jamais facturé une seconde fois.

Ordre de financement :

1. `common.sellers_res` (FIFO par date d'activation des lots vendeurs).
2. `common.inactive_init_asset`.
3. `common.backed_units` pour le complément uniquement.

Le financement système respecte le reliquat du quota administratif non distribuable, initialement fixé à 10 % (`STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO`). Le quota est réduit uniquement par les dépenses administratives validées et cumulées dans `common.sys_inactive_init_asset`. La consommation des réserves système prend les actifs inactifs avant les actifs adossés. Si le financement vendeur couvre toute la recharge, aucune réserve système ni cooldown ONEX n'est consommé. Si une recharge est bloquée par le cooldown et que les vendeurs ne peuvent pas financer intégralement le montant net, aucun crédit partiel n'est réalisé. Le batch est conservé en attente et réévalué périodiquement; il peut être financé dès que la réserve vendeurs devient suffisante ou lorsque le cooldown expire.

Seule une recharge réellement créditée via `ONEX` démarre le cooldown hebdomadaire. Un crédit financé par les vendeurs utilise `XUSER` comme expéditeur comptable. Les crédits utilisent une transaction SQL atomique et revérifient solde, source, cooldown et réserves immédiatement avant leur application.

Les adresses individuelles sont consolidées vers le treasury lorsque les événements finalisés non balayés atteignent 70 BSC-USD, ou lorsque le plus ancien dépôt non balayé atteint 30 jours. Cette consolidation est un mouvement de trésorerie distinct de la validation comptable.

## Campagnes et réserve vendeurs

`POST /app/join-system-sellers` permet de demander une campagne vendeur. Conditions : solde strictement supérieur à 12 XTU; `run_balance` choisi au moins égal à 50 % du solde et à 12 XTU, sans dépasser le solde; `pending_bonus` au moins égal à 10 % de `run_balance`.

`run_balance` est une référence fixe de campagne. À l'activation, 50 % de `run_balance` (hors bonus) est affecté à `common.sellers_res`, avec sa base initiale proportionnelle dans `common.sellers_init_asset`. Le solde principal affiché n'est pas diminué à la simple activation.

Pendant une campagne active ou en annulation en attente, le montant maximal sortant en P2P est :

`balance - 0.5 * run_balance`

Les transferts entrants restent autorisés. `/app/cancel-system-sellers` demande l'annulation, mais ne libère pas directement la réserve. `POST /admin/unlock-system-seller` libère uniquement la portion non consommée après authentification et justification administratives. La campagne expire après sept jours; le worker vendeur clôture les campagnes expirées et libère les lots inutilisés. Les montants déjà consommés demeurent des dettes de paiement envers le vendeur.

Les lots sont suivis individuellement dans `users_seller_reserve_lots`, puis consommés en FIFO. Lorsqu'un lot finance une recharge, la base et le solde XTU du vendeur sont diminués proportionnellement à la consommation; une dette de paiement vendeur est créée. Les dettes atteignant ensemble 300 XTU sont regroupées en lots de paiement, chacun plafonné à 300 XTU et ventilé par vendeur vers son adresse de paiement enregistrée.

Le paiement vendeur est envoyé depuis le treasury en BSC-USD. Il n'y a pas de `tfees`; seul le coût estimé du gas BSC payé par OneX est récupéré sur le paiement du vendeur. Le coût réel est comptabilisé séparément après finalité. Les lots non payés restent une dette tant qu'une transaction n'est pas confirmée.

**Bonus non implémenté :** le stockage de `pending_bonus` et le contrôle du seuil d'éligibilité sont présents. L'origine, la génération, l'accumulation, le calcul, le délai de grâce de 24 heures, la réinitialisation liée à l'inactivité et le crédit automatique du bonus ne sont pas implémentés tant que le cycle complet n'est pas défini. Aucun montant de bonus n'est créé par cette version.

## Transferts P2P et frais

`/app/near-transfer` refuse `ONEX` comme expéditeur. Pour un transfert utilisateur-vers-utilisateur :

- `priceValue = sender.balance / sender.init_asset`.
- L'expéditeur est débité uniquement du montant brut demandé en XTU.
- Le destinataire supporte l'intégralité de `tfees` et reçoit le montant net.
- Aucun gas BSC n'est facturé à un transfert P2P.
- La totalité des frais est conservée par OneX; aucune répartition en parts de récompense distinctes n'est appliquée.
- La base initiale du destinataire est augmentée uniquement de la base correspondant au montant net reçu; son historique n'est pas repricé au prix de l'expéditeur.
- La base initiale de l'expéditeur est mise à jour selon son nouveau solde et le prix de l'opération.
- La limite de 300 XTU et le verrouillage vendeur sont contrôlés dans la transaction SQL.

## Vente à ONEX (disbursement)

La vente système est distincte du P2P. Conditions : solde d'au moins 290 XTU, adresse de paiement enregistrée, aucune demande non résolue, et une vente réussie au maximum tous les 90 jours. Le solde entier est vendu; `tfees` est appliqué au brut :

`fee = gross_balance * FEES / 100`

`payout = gross_balance - fee`

La demande réserve le montant pendant 60 minutes, puis est signée et envoyée par le worker isolé du treasury. Les campagnes vendeurs actives ou en annulation en attente interdisent la liquidation à ONEX. Les demandes en attente sont déduites de la liquidité disponible et le reliquat du quota administratif non distribuable de 10 % ne peut pas être utilisé pour les ventes.

Après transfert BSC-USD canonique et finalisé : `common.total_units_price` diminue du montant net effectivement payé; la base initiale correspondant au net payé est ajoutée à `inactive_init_asset`; la base initiale correspondant à la totalité des frais retenus est ajoutée à `backed_units`. La valeur BSC-USD des frais augmente `common.total_tfees`. Seules les ventes confirmées démarrent le cooldown de 90 jours.

Un échec on-chain ne restaure pas le solde avant confirmation de la canonicalité et 15 confirmations (ou la profondeur configurée). Une transaction signée/soumise est suivie par son hash; aucun nouveau paiement ne doit être signé simplement parce qu'un délai est dépassé.

## Remboursements

Un remboursement de recharge n'applique aucun `tfees`. Seule la récupération estimée du gas BSC supporté par OneX est déduite du brut. Le net remboursé doit être au moins de 10 BSC-USD. Le transfert sortant est traité par le worker du treasury, et la finalisation exige canonicalité et profondeur de confirmation configurée. Toute situation non résolue reste en revue manuelle.

## Frais BSC et agrégats

`BNB_USD_PRICE` doit être une cotation positive capturée et configurée au moment du déploiement pour les workers BSC sortants. Ce n'est pas un flux de prix en direct. Le même prix de référence doit être renseigné dans `.env` et `.env.sweeper`, ce dernier étant chargé avec priorité par le worker de consolidation.

Les estimations et les coûts réels ne sont jamais confondus :

- `total_bnb_fee_estimated` : BNB estimé.
- `total_bnb_fee_estimated_value` : équivalent BSC-USD estimé.
- `total_bnb_fee_actual` : BNB réel issu du reçu.
- `total_bnb_fee_actual_value` : équivalent BSC-USD réel au prix capturé.
- `total_tfees` : cumul historique monotone de la valeur BSC-USD des frais de transaction retenus par OneX.

Le coût réel est `gasUsed * effectiveGasPrice`. Chaque transaction est journalisée dans `bsc_fee_ledger` et ne doit être comptabilisée qu'une fois. Les snapshots `common` préservent tous les cumuls.

## Réserve administrative 10/90 et mise à jour du common stock

Le quota administratif est fixé à l'initialisation à `STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO`, avec `SYSTEM_ADMIN_RESERVE_RATIO=0.10` par défaut. Il est calculé sur le `STOCK_LIMIT` initial, et non sur le `total_units_price` courant. Les 90 % restants constituent la capacité initiale distribuable. La portion administrative demeure comprise dans `common.total_units_price` et `common.backed_units`, mais les recharges système et les disbursements ordinaires ne peuvent pas consommer son reliquat protégé. `INITIAL_BACKED_UNITS` doit être au moins égal au quota administratif initial et ne doit jamais déclarer plus d'actifs que ceux réellement détenus.

`common.sys_inactive_init_asset` est un compteur cumulatif en actifs initiaux. Il représente la base initiale dépensée par les opérations administratives sur l'allocation administrative. Il n'est pas une réserve utilisable et n'est pas additionné à `backed_units` ou `inactive_init_asset`. Le reliquat protégé est :

```text
initial_admin_quota = STOCK_LIMIT * SYSTEM_ADMIN_RESERVE_RATIO
remaining_admin_quota = initial_admin_quota - common.sys_inactive_init_asset
```

Le calcul bloque si `sys_inactive_init_asset` est négatif ou dépasse le quota initial. Pour les recharges et les réservations de disbursement, les actifs initiaux distribuables sont calculés comme `max(0, backed_units + inactive_init_asset - remaining_admin_quota)`. Une consommation administrative validée diminue le reliquat protégé et `backed_units` du même montant initial; elle ne rend donc pas disponible aux opérations utilisateur la portion administrative encore non dépensée. Au démarrage, le serveur vérifie aussi que `backed_units` couvre à lui seul le reliquat protégé; une incohérence bloque le démarrage. La réserve vendeurs reste suivie séparément.

La route administrative est `POST /admin/update-common-stock` (ancien chemin remplacé, aucun alias conservé). Le paramètre `amount` est exprimé en XTU / BSC-USD, comme confirmé pour la branche common-stock. La conversion utilise le `common.unit_price` lu avant l'opération :

```text
spent_initial_asset = amount / current_unit_price
backed_units_after = backed_units_before - spent_initial_asset
sys_inactive_init_asset_after = sys_inactive_init_asset_before + spent_initial_asset
remaining_admin_quota_after = remaining_admin_quota_before - spent_initial_asset
```

Le rachat administratif réduit le stock total XTU du montant dépensé et conserve le prix courant : `total_units_price_after = total_units_price_before - amount`; `unit_price_after = current_unit_price`. Il ne s'agit ni d'une émission de nouvelles unités ni d'une opération de revalorisation. L'opération est rejetée si `amount` dépasse la valeur XTU du quota administratif encore disponible au prix courant, si elle ramène `total_units_price` à zéro ou moins, ou si elle crée une réserve négative ou un compteur supérieur au quota. La branche existante qui met à jour le stock d'un utilisateur est conservée sur ce même endpoint; seul le chemin HTTP est renommé.

Tous les `tfees` retenus lors des recharges, P2P et ventes à ONEX sont conservés par OneX. Leur base initiale complète est ajoutée à `backed_units` et leur valeur BSC-USD équivalente augmente `common.total_tfees`. Ce compteur est cumulatif et ne diminue jamais. Il n'existe plus de portefeuille séparé, de file de transferts ni de transfert automatique lié à ces frais. Les frais BNB de chaque opération blockchain demeurent comptabilisés séparément dans `bsc_fee_ledger`.

Pour une base issue d'une ancienne version, la nouvelle application n'utilise plus les anciens compteurs ni l'ancienne table d'historique des récompenses. Avant de supprimer d'anciennes colonnes ou tables, sauvegarder leurs valeurs et l'historique; vérifier qu'aucun paiement historique n'est encore en attente. La mise à jour du code ne convertit pas automatiquement les anciens snapshots. La procédure recommandée pour le déploiement initial reste une base neuve conformément au schéma cible.

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
