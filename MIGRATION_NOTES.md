# OneX — règles et schéma de première mise en production

## Statut du projet

Cette version est destinée à un projet OneX **pas encore déployé**. Elle définit directement le schéma cible. Elle ne doit pas exécuter de migration de données historiques, de `ALTER TABLE` correctif ni de backfill d'anciennes valeurs.

Créer une base MySQL neuve et vide. `db.js` crée les tables cibles avec `CREATE TABLE IF NOT EXISTS`, puis vérifie les colonnes requises. Si une ancienne structure existe déjà, le démarrage échoue avec un message indiquant que le schéma n'est pas le schéma courant.

`STOCK_LIMIT` initialise `common.total_units_price`. `INITIAL_BACKED_UNITS` initialise `common.backed_units` lors du premier démarrage uniquement. La valeur par défaut est zéro : configure uniquement la réserve initiale réellement disponible avant d'activer les paiements. Elle ne peut pas dépasser `STOCK_LIMIT`. Aucune réserve n'est inventée ou automatiquement provisionnée.

## Actif et conventions

- Token réseau accepté : Binance-Peg BSC-USD, contrat `0x55d398326f99059fF775485246999027B3197955`, BNB Smart Chain mainnet, chain ID 56, 18 décimales.
- Ce token n'est pas un USDt directement émis par Tether.
- Équivalence opérationnelle : 1 One-Val = 1 BSC-USD reçu/payé.
- `users_stock.balance` : One-Val direct.
- `users_stock.init_asset` : base en actifs initiaux.
- `activities.amount` et `activities.fees` : actifs initiaux, selon la convention de chaque opération.
- `activities.unit_price` : prix retenu pour l'opération.
- `common.total_units_price` : valeur en One-Val.
- `common.unit_price` : prix courant de l'actif initial.
- `common.backed_units` et `common.inactive_init_asset` : réserves en actifs initiaux.
- Plafond de stock utilisateur : 300 One-Val.

## Recharges automatiques

L'utilisateur n'ouvre pas de commande avant d'envoyer les tokens. Le scanner détecte un événement `Transfer` finalisé sur l'adresse de dépôt OneX unique de l'utilisateur et ouvre automatiquement un batch.

Le batch regroupe les transferts reçus pendant les 60 minutes qui suivent le premier événement finalisé. Les transferts sont identifiés par le couple transaction hash + log index. Après clôture :

- Total inférieur à 70 BSC-USD : `pending_support`.
- Total supérieur à 140 BSC-USD : `pending_support`.
- Total entre 70 et 140 : contrôle de compte, cooldown, plafond de stock et réserves.
- Recharge créditée : statut `credited`; seules ces opérations déclenchent le cooldown de sept jours.
- Cooldown actif : `pending_weekly`, avec relance automatique au plus tôt sept jours après la première mise en attente et sept jours après la dernière recharge réussie. Les contrôles sont réexécutés à la relance.
- Réserves insuffisantes : `pending_reserve`, avec nouvelle tentative automatique.
- Litige ou anomalie : `pending_support` et notification Telegram en anglais lorsque le compte a associé le bot. Aucune notification transactionnelle par SMTP n'est envoyée.

Une seule session `collecting` est ouverte par utilisateur à la fois. Des batches déjà `pending_weekly` ou `pending_reserve` peuvent coexister avec une nouvelle session; un dossier `pending_support` non résolu empêche une nouvelle attribution automatique et place les nouveaux paiements en support.

Une recharge est créditée dans une transaction SQL atomique qui met à jour `activities`, `users_stock`, `common` et le batch. Le contrôle de stock/réserve est refait immédiatement avant crédit.

## Réserves lors d'une recharge

La réserve disponible en valeur One-Val est :

`(common.inactive_init_asset + common.backed_units) * common.unit_price`

Consommation :

1. `inactive_init_asset` d'abord.
2. `backed_units` pour compléter uniquement.

Si la réserve inactive suffit, `unit_price` reste inchangé. Si `backed_units` est consommé, `unit_price` est recalculé selon la formule de valorisation existante dans `stock-accounting.js`. Le montant complet du top-up augmente `common.total_units_price`.

## Bonus et cooldown

Le bonus de bienvenue est enregistré avec `sender='XBONUS'`; il ne déclenche pas le cooldown des recharges. Une recharge OneX réellement créditée utilise `sender='ONEX'`, `receiver=username`, `type=2`. Les recharges administratives qui utilisent le même chemin de crédit comptent dans le cooldown.

## Consolidation des dépôts

Chaque adresse est consolidée individuellement vers le treasury OneX lorsque son total d'événements finalisés non encore balayés atteint 70 BSC-USD, ou lorsque son plus ancien transfert non balayé atteint 30 jours. Les événements sont conservés, y compris les paiements en attente ou remboursés. La consolidation est un mouvement de trésorerie distinct de la validation comptable. Le gas est payé en BNB.

## P2P

`/app/near-transfer` accepte les transferts utilisateur-vers-utilisateur et la vente utilisateur-vers-ONEX. `ONEX` est refusé comme expéditeur.

Pour le P2P :

- `priceValue = sender.balance / sender.init_asset`.
- Les frais totaux sont calculés en actifs initiaux, avec 50 % supportés par chaque utilisateur.
- `activities.amount = (requestedAmount / priceValue) - receiverFee`.
- `activities.fees` enregistre les frais totaux en actifs initiaux.
- Après le transfert, le `init_asset` de l'expéditeur est recalculé comme nouveau solde / `priceValue`.
- Le `init_asset` du destinataire conserve sa base historique et augmente uniquement de `receiverAmountUnits`, exprimé en actifs initiaux. Il ne doit pas être recalculé à partir du nouveau solde destinataire divisé par le prix de l'expéditeur.
- Cette règle conserve les actifs initiaux : la diminution de base chez l'expéditeur, l'augmentation nette chez le destinataire et les frais affectés aux réserves doivent avoir une variation totale nulle, à l'arrondi près.
- Le crédit One-Val du destinataire reste `receiverAmount * priceValue`; seul son `init_asset` est mis à jour de manière additive. Si son `balance` et son `init_asset` sont incohérents (un seul des deux est nul), le P2P est refusé plutôt que de reconstituer sa base au prix de l'expéditeur.
- 75 % des frais initiaux vont à `common.backed_units`; 25 % vont à `common.inactive_init_asset`.
- La valeur commune augmente de la part de frais adossée convertie au `priceValue`.
- Le destinataire ne peut pas dépasser 300 One-Val.

## Disbursement

La vente à ONEX liquide le solde entier. Les frais sont déduits du brut :

`fee = gross_balance * FEES / 100`

`payout = gross_balance - fee`

Conditions : solde initial au moins 290 One-Val, adresse de versement déclarée par l'utilisateur, montant attendu correspondant au net calculé, et aucune demande en cours. Une demande réussie n'est autorisée qu'une fois par période glissante de 90 jours. Seuls les disbursements `confirmed` comptent.

Après confirmation du transfert on-chain :

- la base initiale du montant net envoyé augmente `inactive_init_asset`;
- la base initiale des frais est répartie à 25 % dans `inactive_init_asset` et à 75 % dans `backed_units`;
- `common.total_units_price` diminue exactement du payout net envoyé en BSC-USD; la répartition des réserves de frais est suivie séparément et n'est pas ajoutée une seconde fois à ce total;
- les écritures comptables et le passage au statut confirmé sont atomiques.

Une réservation non soumise expire après 60 minutes et passe en `manual_review`. Elle n'est pas restaurée automatiquement tant qu'il n'est pas établi qu'aucune transaction n'a été soumise. Une transaction signée ou soumise est suivie par son hash existant; jamais de nouvelle signature ou de restauration sur simple timeout.

`POST /admin/unlock-disbursement` ne signe pas la transaction dans le serveur HTTP. Il vérifie admin, job, expiration, montant minimal 10 BSC-USD et liquidité (BSC-USD + BNB), puis remet le job dans la file du worker séparé.

## Résolution administrative des paiements support

Un batch `pending_support` peut être crédité exceptionnellement par `POST /admin/recharge/credit`. Cette action bypass uniquement la plage automatique 70–140; elle conserve le contrôle du cooldown hebdomadaire, du plafond de 300 One-Val, du compte et des réserves. L'action nécessite des identifiants administrateur et une justification, et crée un journal dans `admin_payment_resolutions`.

Le remboursement d'une recharge est différent d'un disbursement de vente. `POST /admin/recharge/refund` met en file un remboursement complet d'un batch `pending_support`, vers l'adresse de versement déclarée, si montant >= 10 BSC-USD et liquidité disponible.

Les frais de gas du transfert sortant sont payés en BNB par le treasury. Aucun frais blockchain n'est déduit du montant BSC-USD par cette route. Le remboursement est finalisé seulement après transaction canonique et nombre de confirmations configuré. Les erreurs non résolues restent en revue manuelle.

## Suppression de compte

Le solde doit être <= 2 One-Val et aucune recharge, aucun paiement, remboursement ou disbursement ne doit rester non résolu. Les données d'authentification et le stock sont supprimés, mais les activités et l'historique financier sont conservés. L'adresse de dépôt reste réservée avec `account_status='deleted'`; elle ne doit jamais être réattribuée. Les paiements ultérieurs vers cette adresse sont mis en support, jamais crédités à un autre compte.

## Adresses et preuve de propriété

OneX ne vérifie pas cryptographiquement que l'adresse source d'un paiement appartient à l'utilisateur. Aucun EIP-191 ou WalletConnect n'est requis pour cette fonction. L'attribution repose sur l'adresse de dépôt OneX destinataire. L'utilisateur est responsable de fournir une adresse personnelle correcte pour recevoir les disbursements et remboursements; la propriété de cette adresse n'est pas prouvée par le serveur.

## UTC, worker et secrets

Toutes les nouvelles dates/horaires et timestamps sont en UTC (+0). Aucune conversion des anciennes données n'est prévue puisque le projet n'est pas encore déployé.

Trois processus indépendants :

- HTTP + scanner des dépôts : aucune clé privée de portefeuille.
- `npm run sweep` : XPRV HD des dépôts et clé du wallet de financement gas, dans `.env.sweeper`.
- `npm run disburse` : clé du treasury, dans `.env.disbursement`.

Les vrais fichiers `.env` ne doivent jamais être inclus dans une archive ou un dépôt de code. Distribuer uniquement les fichiers `.env.example`, `.env.sweeper.example` et `.env.disbursement.example`.

## Vérifications

- `npm run check` : syntaxe JavaScript.
- `npm test` : tests des fonctions comptables/politiques.
- Avant mainnet : tests d'intégration sur une base MySQL neuve, BNB Smart Chain testnet lorsque possible, SMTP et tests de reprise après redémarrage. Les tests de syntaxe/unitaires ne prouvent pas la disponibilité réelle des services externes.

## Authentification, récupération et notifications Telegram

- `auths.consec_failed_auth` est créé avec `DEFAULT 0`. Chaque mot de passe incorrect soumis à `/app/signin` incrémente le compteur jusqu'à 3. À partir de 3, le mot de passe permanent ne permet plus de se connecter. Une connexion normale réussie ne remet pas le compteur à zéro.
- `/app/recover-account` vérifie le seed de récupération, génère un code numérique aléatoire de 7 chiffres, le hache avec Argon2id, le stocke avec une échéance de 10 minutes et l'envoie par SMTP à `auths.email`. L'envoi ne réinitialise pas `consec_failed_auth`.
- `/admin/send-temp-pswd` est une voie administrative indépendante. Elle vérifie le mot de passe et le PIN administrateur, envoie le même type de code à 7 chiffres valable 10 minutes à l'adresse email enregistrée, et ne réinitialise pas le compteur d'échecs.
- Un code temporaire valide autorise `/app/signin` même si le compteur est à 3, avec `password_change_required=true`. Dès que la connexion avec ce code et les vérifications additionnelles éventuelles (seed) réussissent, `consec_failed_auth` est remis à `0` dans la transaction de connexion. Le marqueur `password_temp_expires_at_ms` reste défini et toutes les autres activités protégées par mot de passe répondent exactement `{ "auth": "not allowed" }` jusqu'au changement du mot de passe temporaire. `/app/modify-pin-or-password` est l'exception autorisée : elle vérifie que le code temporaire est encore valide, exige un nouveau mot de passe différent, puis efface le marqueur et conserve le compteur à `0` dans une transaction SQL.
- Un code temporaire expiré ne permet pas de se connecter et ne lève pas le verrouillage des activités : le marqueur de récupération reste présent jusqu'à l'émission d'un nouveau code valide puis au changement du mot de passe permanent. Une nouvelle demande de récupération ou une nouvelle émission administrative peut générer un code après expiration. Une émission simultanée alors qu'un code est encore valide est refusée afin d'éviter plusieurs codes concurrents.
- Le mot de passe temporaire n'est jamais retourné dans une réponse API ni écrit dans les journaux applicatifs. Le message email en donne la valeur une seule fois.
- Telegram est facultatif. `/app/signin` retourne `tg_botLink`, soit le lien du bot si l'utilisateur est déjà associé, soit un lien profond `/start` avec un token temporaire de 10 minutes. L'association est faite uniquement dans une conversation privée.
- `telegram-worker.js` utilise `getUpdates` en long polling, traite `/start` et `my_chat_member`, et envoie `telegram_outbox`. Il faut lancer un seul worker avec `npm run telegram`. Les messages transactionnels sont en anglais. Un blocage du bot efface uniquement les identifiants Telegram.
- Nodemailer reste utilisé pour l'envoi du username à l'inscription, le mot de passe temporaire de récupération, `/app/contact-onex`, ainsi que le courriel administratif existant de vérification des pièces d'identité lors de l'inscription. Les notifications transactionnelles ne sont plus envoyées par email.
- La table `notifs`, `/app/feed` et `/admin/add-to-feed` sont exclus du schéma et des routes. `telegram_outbox` est une file de livraison technique, pas un historique de notification.


Telegram delivery note: the outbox provides at-least-once delivery. If Telegram accepts a message but the worker stops before recording `sent`, the message can be delivered again after restart. Transaction references in messages make such a duplicate recognizable; Telegram `sendMessage` does not provide a general exactly-once idempotency key.

## Encodage des requêtes

- Le serveur conserve les valeurs reçues et ne remplace plus les espaces par des signes `+`. Express décode normalement `application/x-www-form-urlencoded`.
- Le client Android doit utiliser un encodeur standard. Un `+` littéral doit être envoyé sous la forme `%2B`; ne jamais modifier manuellement une valeur après encodage. Les requêtes JSON préservent les espaces et les signes `+`.
