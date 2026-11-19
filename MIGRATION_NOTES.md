# OneX — schéma cible et règles comptables en actifs initiaux

## Inscription internationale et pièces d'identité

- L'inscription est ouverte aux adultes admissibles quel que soit leur pays, sous réserve du droit applicable. La géolocalisation IP est uniquement informative ; elle ne détermine ni la nationalité, ni le pays de résidence, ni la pièce exigée, ni l'acceptation de l'inscription.
- Le corps de la requête `/app/signup` doit contenir `nationality` et `residenceCountry`, sous forme de codes pays ISO 3166-1 alpha-2. Les deux pays déclarés sont comparés : si la personne réside dans le pays de sa nationalité, une carte nationale d'identité délivrée par ce pays est acceptée lorsqu'elle est disponible, et le passeport est également accepté ; si elle réside dans un autre pays, elle est traitée comme résidente étrangère et doit fournir un passeport valide.
- Cette règle concerne toutes les nationalités. `CNI` n'est pas réservé à Madagascar : le type canonique enregistré est `NATIONAL_ID`, et l'ancien alias API `CNI` est normalisé vers `NATIONAL_ID`. `PASSPORT` est le second type canonique. `identityType` est facultatif : par défaut, `NATIONAL_ID` est choisi pour une personne résidant dans le pays de sa nationalité et `PASSPORT` pour une personne résidant à l'étranger. Une valeur qui contredit la règle de résidence étrangère est rejetée.
- Le numéro et les images du document sont transmis dans `identityNumber` et `identityImage1`; `identityImage2` est facultatif. Les anciens paramètres API `cni`, `cniimg1` et `cniimg2` restent acceptés comme alias temporaires ; ils ne correspondent pas à des colonnes SQL.
- Le schéma initial `auths` contient les champs obligatoires `nationality`, `residence_country`, `identity_document_type` et `identity_document_number`. Les pays sont enregistrés en codes ISO alpha-2, et le numéro du document est chiffré avant son insertion. Le projet n'étant pas déployé, créer une base MySQL neuve à partir du schéma actuel de `db.js`. Aucune migration SQL ni reprise de données historiques n'est requise ou fournie.
## Statut du schéma

Cette version définit le schéma cible pour une première mise en production. Elle ne migre pas les anciennes tables et ne convertit pas les anciens soldes. Créer une base MySQL neuve et vide. `db.js` crée les tables, vérifie les colonnes et valide le prix global au démarrage. Une ancienne structure qui ne correspond pas au schéma cible provoque une erreur explicite; ne pas la réutiliser sans une migration distincte, auditée et sauvegardée.

Par défaut, une nouvelle base initialise `common.total_units_price=18000000`, `common.backed_units=18000000`, et donc `common.unit_price=1`. `STOCK_LIMIT` et `INITIAL_BACKED_UNITS` règlent les valeurs initiales. La quantité d'actifs déclarée doit correspondre aux actifs réellement détenus. `INITIAL_BACKED_UNITS` doit couvrir le quota administratif initial de 10 %.

## Convention d'unités

- Réseau : BNB Smart Chain mainnet, chain ID 56.
- Token de règlement : Binance-Peg BSC-USD (BEP-20), contrat `0x55d398326f99059fF775485246999027B3197955`, 18 décimales. Il ne s'agit pas d'un USDt émis directement par Tether.
- **Tous les soldes et réserves internes sont enregistrés en actifs initiaux.** Cela comprend `users_stock.balance`, `users_stock.run_balance`, `common.backed_units`, `common.inactive_init_asset`, `common.sys_inactive_init_asset`, `common.sellers_res` et `common.total_run_balance`.
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

`SYSTEM_ADMIN_RESERVE_RATIO` vaut 0.10 par défaut. Pour `STOCK_LIMIT=18,000,000` par défaut, le quota administratif initial est de 1,800,000 actifs initiaux et la capacité distribuable initiale est de 16,200,000. Les 1,800,000 sont déjà compris dans `backed_units` et continuent à participer à `unit_price`. Les recharges et ventes ordinaires peuvent consommer `inactive_init_asset` et la partie de `backed_units` supérieure au quota administratif restant.

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

Chaque compte possède une adresse individuelle de dépôt BSC-USD. Les dépôts finalisés sont identifiés par hash de transaction et index du journal d'événement puis regroupés dans une session de recharge de 60 minutes.

- Le montant total d'une session automatique doit être compris entre **10 et 100 BSC-USD inclus**. En dehors de cette plage, la session passe en `pending_support` et n'est pas créditée partiellement.
- Le seuil de sweep du portefeuille de dépôt est de **100 BSC-USD**. Les dépôts finalisés non balayés sont également traités après 30 jours.
- Le cooldown de sept jours s'applique uniquement à la part nécessitant un financement par les réserves système ONEX. Les financements provenant des lots vendeurs n'utilisent pas ce cooldown système.
- Le solde public de l'utilisateur après crédit ne doit jamais dépasser 300 XTU, au prix global recalculé après l'opération.
- Le crédit net est `montant reçu - tfees`. Les coûts BSC réels des transactions de financement et de sweep sont répartis au prorata entre les sessions concernées. Ils sont imputés sur les `tfees` bruts ; seul le reliquat augmente les réserves et `common.total_tfees`. Tout dépassement de coûts BSC est enregistré comme coût OneX et n'est pas facturé une seconde fois à l'utilisateur.
- Priorité de financement : `common.inactive_init_asset`, puis lots vendeurs actifs en FIFO, puis `common.backed_units` au-delà du quota administratif restant. Les réservations de décaissement réduisent la capacité finançable.
- Un crédit financé par un lot vendeur transfère les actifs initiaux du lot vers le bénéficiaire ; le lot vendeur du bénéficiaire est exclu de son propre financement.
- Une recharge qui dépasse le plafond utilisateur est mise en attente pour support, sans crédit. Les opérations administratives de crédit exceptionnel peuvent contourner la plage automatique 10–100 après examen, mais ne contournent pas le plafond utilisateur ni les protections de réserve.

## Rémunération individuelle et campagnes vendeurs

Aucun bonus séparé n'est distribué. Chaque compte possède un prix de référence `A` et un seuil individuel `B` calculé avec le taux `tfees` réellement appliqué à sa dernière acquisition :

```text
B = A * (1 + 2 * tfees / 100)
```

Une recharge ou une acquisition/vente réussie réinitialise `A` au prix global obtenu après l'opération. Avant une acquisition, le serveur vérifie si le seuil précédent a déjà été atteint avec le solde principal antérieur à l'opération; l'acquisition met ensuite à jour `A/B` sans lever une pause existante. Un franchissement met en pause l'accumulation individuelle et crée une notification Telegram. Les variations de prix sont enregistrées dans `common_price_events`; le worker parcourt les seuils indexés uniquement pour les événements de hausse, sans balayage périodique complet des comptes.

Au franchissement, le serveur fige `S0`, le solde principal en actifs initiaux, et calcule le volume de ventes requis `50 % * S0`. Seules les sorties P2P réussies sont cumulées en montant brut initial (avant les tfees supportés par le destinataire). Les P2P entrants, les activations vendeurs, la consommation des lots vendeurs et les ventes à OneX ne sont pas des ventes admissibles. Une recharge reçue pendant la pause réinitialise `A/B`, mais la pause demeure jusqu'à ce que le volume P2P requis soit atteint. À ce moment, un nouveau cycle démarre automatiquement au prix global courant.

L'adhésion vendeur nécessite un seuil individuel déjà atteint et un solde principal public d'au moins 10 XTU. À l'activation, le serveur engage automatiquement 50 % de la totalité du solde principal en actifs initiaux dans `common.sellers_res`; l'utilisateur ne choisit plus un montant de verrouillage et aucun bonus n'est exigé. Le solde principal n'est pas débité au seul motif de l'activation : le montant engagé est bloqué par un lot vendeur. Un même cycle de prix ne peut servir qu'à une campagne. La campagne et le lot conservent le prix global à l'activation pour fixer leur valeur de paiement.

Les lots vendeurs sont consommés en FIFO. La consommation débite le solde vendeur en actifs initiaux et crée une dette de paiement. Les paiements sont regroupés par lots d'au plus 300 BSC-USD brut; le prix utilisé est le prix de campagne figé. Aucun `tfees` n'est appliqué au vendeur prioritaire; seul le gas BSC estimé est récupéré. Les campagnes durent sept jours. Une annulation ne libère pas les lots tant qu'ils n'ont pas été déverrouillés par l'administration ou par la fermeture normale. La disponibilité P2P d'un vendeur est son solde principal moins le montant réel encore bloqué dans ses lots actifs.

## Transferts P2P et frais

`POST /app/near-transfer` reçoit un montant public XTU. Le prix global unique est lu sous le verrou `common_state`, puis le montant est converti en actifs initiaux. L'expéditeur est débité du montant brut initial; le destinataire reçoit le montant initial net après déduction de la totalité des `tfees`. Le destinataire supporte les frais; aucun gas BSC n'est appliqué aux transferts P2P.

Pour un transfert P2P, l'intégralité des `tfees` est conservée par OneX, puisqu'aucun coût de gas BSC ne s'applique. Pour les recharges et les décaissements individuels, le coût BSC réel admissible est d'abord imputé sur les `tfees` bruts. Seul le reliquat augmente les réserves système et `common.total_tfees`. À la confirmation d'un paiement de trésorerie, la valeur de stock commune est également débitée du montant BSC-USD réellement transféré et du coût BNB réel valorisé en BSC-USD. `common.total_tfees_bsc_cost_usd` suit les frais BSC couverts par `tfees`; `common.total_tfees_bsc_uncovered_usd` suit les coûts dépassant les `tfees` disponibles et absorbés par OneX. `bsc_fee_allocations` distribue de façon idempotente les coûts de sweep aux lots de recharge.

## Disbursement individuel et disbursement global

Les deux modes utilisent le même parcours utilisateur : `POST /app/near-transfer` avec `dest=ONEX`. Le client ne choisit pas le mode ; le serveur le détermine sous verrou `common_state` selon l'état du run global.

Le **disbursement individuel habituel** est périodique et initié par l'utilisateur. Le montant brut minimal est de **200 XTU** (`DISBURSEMENT_INDIVIDUAL_MINIMUM_XTU`). Le compte doit également disposer d'au moins 290 XTU de solde public, d'une adresse BSC valide, ne présenter aucun engagement vendeur actif ni autre paiement non résolu et respecter le délai glissant de 30 jours après un décaissement individuel confirmé. Le prix courant est figé à l'acceptation, les `tfees` habituels s'appliquent et aucun bonus global n'est accordé.

Le **disbursement global** est une décision définitive de l'administration. `/admin/start-global-disbursement` enregistre l'annonce, la référence administrative, le canal d'information choisi par l'administration, la date d'annonce, la date prévue d'activation, la durée de la fenêtre de demandes et le taux du bonus. La notification peut être envoyée par l'administration en dehors du serveur ; Telegram, e-mail ou une annonce dans l'application ne sont pas imposés techniquement. Le préavis doit couvrir au moins sept jours calendaires complets. La date planifiée n'active jamais le mode automatiquement : l'administration doit appeler explicitement `/admin/activate-global-disbursement`, après le préavis et la résolution des opérations financières bloquantes.

Pendant le préavis, les opérations normales continuent. À l'activation explicite, le serveur fige le prix global, enregistre les comptes participants et la date limite, puis bloque les nouvelles recharges et les transferts P2P entre utilisateurs. Les demandes de disbursement vers `ONEX` restent ouvertes. Le montant brut minimal est de **1 XTU uniquement pendant cette fenêtre globale active**. Chaque utilisateur doit soumettre sa propre demande ; le worker ne crée aucune demande et ne débite aucun solde sans action de l'utilisateur. Après règlement d'une demande, une nouvelle demande peut porter sur le solde restant tant que la fenêtre est ouverte.

Une demande globale est enregistrée avec `disbursement_mode='global'` et son `global_run_id`. Elle utilise le prix figé à l'activation, ne prélève aucun `tfees` et applique le bonus annoncé, calculé sur le montant net XTU demandé. Le bonus suit `FEES` lorsque `GLOBAL_DISBURSEMENT_BONUS` est absent ou vide, et ne peut jamais dépasser 10 %. Exemple : 200 XTU avec un bonus de 3 % donnent 6 BSC-USD de bonus et 206 BSC-USD avant récupération du gas BSC. Le coût estimé est déduit du paiement puis rapproché du gas réellement payé. Le bonus est financé par la réserve administrative protégée, sous réserve des contrôles de réserve et de liquidité.

À l'expiration, aucune nouvelle demande globale n'est acceptée. Les paiements déjà acceptés continuent leur traitement. Aucun remboursement automatique n'est créé pour les comptes n'ayant pas demandé le disbursement ou pour les soldes résiduels. Ces comptes et montants passent en `manual_review` pour résolution administrative individuelle, sans débit automatique. Le run n'est `completed` qu'après règlement des paiements acceptés et résolution des participants en examen. Le cutoff global reste en vigueur après clôture : les recharges et les P2P ordinaires ne reprennent pas automatiquement.

## Historique et frais

`activities.amount` et `activities.fees` sont des actifs initiaux. `activities.unit_price` est le prix global figé à l'opération. L'API d'historique expose les montants internes et calcule aussi les équivalents XTU historiques avec ce prix, jamais avec le prix courant.

`common.total_tfees` est le cumul historique des frais retenus, en actifs initiaux. Les frais BNB sont distincts : `total_bnb_fee_estimated` et `total_bnb_fee_actual` sont en BNB; leurs champs `_value` sont des équivalents BSC-USD capturés. Le gas réel est calculé par `gasUsed * effectiveGasPrice` et journalisé une seule fois dans `bsc_fee_ledger` après finalité.

Les remboursements de recharge approuvés n'appliquent aucun `tfees`; seule la récupération configurée du gas BSC supporté par OneX est déduite. Le minimum net de ce type de remboursement reste 10 BSC-USD. Cette règle de remboursement ne modifie pas les minima des disbursements individuel et global.

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
- Aucun bonus individuel n'est généré ou accumulé. Le seul bonus configuré est le bonus de remboursement automatique réservé au disbursement global.

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


Un run global conserve le prix global, le total `common.total_units_price` et le passif initial total des comptes au lancement. Le lancement est refusé si le passif brut au prix figé épuiserait la valeur stockée. Les jobs globaux restent réservés jusqu’à finalisation ou réconciliation explicite et ne sont pas expirés automatiquement.


## Liquidation globale : activation explicite et demandes utilisateur

L'administration choisit elle-même comment informer les utilisateurs ; le serveur peut enregistrer la date, la référence et le canal déclaré, mais l'annonce n'a pas à être expédiée par OneX. Le préavis minimal est de sept jours calendaires complets. Aucun worker ne transforme automatiquement une annonce en activation. Seule l'action administrative explicite active le mode, fige le prix et ouvre la période de demandes.

Les utilisateurs doivent chacun présenter leur demande à `ONEX` via `/app/near-transfer`. Le mode global est choisi côté serveur, le minimum brut est de 1 XTU, aucun `tfees` n'est prélevé et le bonus s'applique au montant XTU demandé. Le worker traite uniquement les décaissements réellement créés à la suite d'une demande utilisateur ; il ne parcourt pas les soldes pour générer des paiements. À la date limite, les demandes nouvelles sont fermées. Les soldes non demandés et résiduels passent en `manual_review` sans débit ou remboursement automatique.

Le bonus est financé par la réserve administrative protégée de 10 % des actifs initiaux. Le taux est figé à l'annonce, hérite de `FEES` s'il est absent ou vide et reste plafonné à 10 %. Les coûts BSC sont comptabilisés séparément du bonus et rapprochés avec les reçus de blockchain.

`POST /admin/common-history` retourne au plus 50 snapshots `common` par appel, avec pagination par `before_id`, une liste fixe de colonnes et une authentification administrative par mot de passe et PIN.
