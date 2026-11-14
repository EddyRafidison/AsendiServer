# OneX — schéma cible et règles de première mise en production

## Statut du schéma

Cette version est destinée à un projet OneX non encore déployé. Elle définit directement le schéma cible. Elle ne migre pas et ne remplit pas les anciennes tables. Créer une base MySQL neuve et vide. `db.js` crée les tables avec `CREATE TABLE IF NOT EXISTS`, puis vérifie les colonnes requises. Une ancienne structure ne correspondant pas au schéma cible provoque volontairement une erreur au démarrage.

Par défaut, une nouvelle base initialise `common.total_units_price=10000000`, `common.unit_price=1` et `common.backed_units=10000000`. `STOCK_LIMIT` et `INITIAL_BACKED_UNITS` peuvent remplacer ces valeurs; `INITIAL_BACKED_UNITS` prend par défaut la valeur de `STOCK_LIMIT` et ne peut pas la dépasser. La réserve déclarée doit correspondre aux actifs réellement disponibles. La réserve système non distribuable reste fixée à `STOCK_LIMIT * SYSTEM_RESERVE_RATIO` (20 % par défaut).

## Conventions comptables

- Réseau : BNB Smart Chain mainnet, chain ID 56.
- Token : Binance-Peg BSC-USD, contrat `0x55d398326f99059fF775485246999027B3197955`, 18 décimales. Ce n'est pas un USDt directement émis par Tether.
- Équivalence opérationnelle : 1 XTU = 1 BSC-USD.
- `users_stock.balance` : solde XTU direct.
- `users_stock.init_asset` : base en actifs initiaux.
- `users_stock` ne possède pas de `unit_price` individuel.
- `activities.amount` et `activities.fees` suivent la dénomination définie par l'opération; `activities.unit_price` enregistre le prix de conversion utilisé.
- `common.total_units_price` : valeur en XTU.
- `common.backed_units`, `common.inactive_init_asset` et `common.sellers_init_asset` : actifs initiaux.
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

Le financement système respecte le plancher non distribuable de 20 % (`STOCK_LIMIT * SYSTEM_RESERVE_RATIO`). La consommation des réserves système prend les actifs inactifs avant les actifs adossés. Si le financement vendeur couvre toute la recharge, aucune réserve système ni cooldown ONEX n'est consommé. Si une recharge est bloquée par le cooldown et que les vendeurs ne peuvent pas financer intégralement le montant net, aucun crédit partiel n'est réalisé. Le batch est conservé en attente et réévalué périodiquement; il peut être financé dès que la réserve vendeurs devient suffisante ou lorsque le cooldown expire.

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
- Les frais sont répartis à 50 % `CommonShare` et 50 % `AdminFees`.
- La base initiale du destinataire est augmentée uniquement de la base correspondant au montant net reçu; son historique n'est pas repricé au prix de l'expéditeur.
- La base initiale de l'expéditeur est mise à jour selon son nouveau solde et le prix de l'opération.
- La limite de 300 XTU et le verrouillage vendeur sont contrôlés dans la transaction SQL.

## Vente à ONEX (disbursement)

La vente système est distincte du P2P. Conditions : solde d'au moins 290 XTU, adresse de paiement enregistrée, aucune demande non résolue, et une vente réussie au maximum tous les 90 jours. Le solde entier est vendu; `tfees` est appliqué au brut :

`fee = gross_balance * FEES / 100`

`payout = gross_balance - fee`

La demande réserve le montant pendant 60 minutes, puis est signée et envoyée par le worker isolé du treasury. Les campagnes vendeurs actives ou en annulation en attente interdisent la liquidation à ONEX. Les demandes en attente sont déduites de la liquidité disponible et le plancher système de 20 % ne peut pas être utilisé pour les ventes.

Après transfert BSC-USD canonique et finalisé : `common.total_units_price` diminue du montant net effectivement payé; la base initiale correspondant au net payé est ajoutée à `inactive_init_asset`; la base initiale des frais est répartie à 50 % dans `backed_units` (CommonShare) et à 50 % dans `inactive_init_asset` (AdminFees). Seules les ventes confirmées démarrent le cooldown de 90 jours.

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
- `total_common_share`, `total_adminFees` et `remaining_adminFees` : montants en BSC-USD. `total_adminFees` est un cumul historique monotone; `remaining_adminFees` est le solde encore disponible pour le paiement administratif.

Le coût réel est `gasUsed * effectiveGasPrice`. Chaque transaction est journalisée dans `bsc_fee_ledger` et ne doit être comptabilisée qu'une fois. Les snapshots `common` préservent tous les cumuls.

## Récompenses administratives (`AdminFees`)

`AdminFees` sont libellés en BSC-USD. `common.total_adminFees` cumule toutes les récompenses administratives générées depuis le lancement et ne diminue jamais. `common.remaining_adminFees` suit uniquement la partie qui reste dans le treasury principal; elle augmente à chaque attribution et diminue seulement après confirmation blockchain définitive du transfert vers l'adresse administrative dédiée.

La base d'actifs initiaux correspondant aux AdminFees reste dans les réserves système : les frais de recharge et P2P ajoutent leur base équivalente à `inactive_init_asset`; la liquidation système répartit la base des frais 50/50 entre `backed_units` (CommonShare) et `inactive_init_asset` (AdminFees). Le versement des récompenses BSC-USD ne débite pas ces réserves initiales.

Dès que `remaining_adminFees >= ADMIN_FEES_THRESHOLD_USD` (100 BSC-USD par défaut), une demande est créée pour transférer exactement `remaining_adminFees - ADMIN_FEES_RETAINED_BALANCE_USD` (10 BSC-USD par défaut). Une seule demande non résolue peut exister à la fois. Si de nouveaux frais sont accumulés pendant le transfert, le worker réévalue le solde après confirmation et crée une autre demande si le seuil est toujours atteint. Une valeur de seuil nulle, négative ou non finie, une réserve résiduelle invalide, une adresse invalide ou `ADMIN_FEES_TRANSFERS_ENABLED=false` empêchent la création des transferts. Le worker ne soumet pas non plus les demandes déjà en file tant que cette configuration reste invalide; elles restent en attente et ne reprennent qu'après réactivation d'une configuration valide.

Le worker treasury `npm run disburse` utilise la clé du treasury principal dans `.env.disbursement`, envoie le montant BSC-USD sans déduire le gas, puis comptabilise le gas BNB séparément dans `bsc_fee_ledger`. Le solde `remaining_adminFees` est protégé de toute autre sortie : les disbursements utilisateurs, paiements vendeurs et remboursements ne peuvent utiliser cette part de la liquidité du treasury. La diminution de `remaining_adminFees` intervient uniquement après vérification de la canonicalité, des confirmations requises et de l'événement BSC-USD `Transfer` vers l'adresse dédiée. `POST /admin/admin-fees-transfers` expose l'historique paginé aux administrateurs authentifiés.

## Telegram et SMTP

Telegram est facultatif. `/app/signin` renvoie `tg_botLink`; l'association se fait dans une conversation privée avec un token temporaire de dix minutes. Un seul worker `npm run telegram` doit exécuter le long polling. Les messages transactionnels sont en anglais et envoyés via `telegram_outbox`, uniquement lorsque le compte est associé. La file offre une livraison au moins une fois; un doublon reste possible après arrêt du worker entre l'envoi et l'enregistrement du statut `sent`.

SMTP reste réservé à l'inscription, la récupération de compte, `/app/contact-onex` et au flux administratif de vérification d'identité déjà existant. Les notifications transactionnelles ne sont pas envoyées par email. `notifs`, `/app/feed` et `/admin/add-to-feed` restent supprimés.

## Secrets et workers

Les fichiers `.env` réels ne doivent jamais être distribués. Fournir uniquement `.env.example`, `.env.sweeper.example` et `.env.disbursement.example`.

- HTTP + scanner : aucune clé privée de wallet.
- `npm run sweep` : clé HD des adresses de dépôt et clé du financeur gas dans `.env.sweeper`.
- `npm run disburse` : clé du treasury dans `.env.disbursement`; les flags, l'adresse dédiée AdminFees, les seuils et `BNB_USD_PRICE` viennent du `.env` principal. Ce worker traite aussi les demandes AdminFees lorsque `ADMIN_FEES_TRANSFERS_ENABLED=true`.
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
