# OneXServer — Révision 5, MAJ6 UPDATE3 — Rapport d'implémentation Étape 2

Date de livraison : 28 novembre 2026  
Base : `OneXServer-Revision5-MAJ6-Stage1-2026-11-28.zip`  
Spécification de référence : `ONEXSERVER_REVISION5_MAJ6_CONSOLIDEE_MAJ6_UPDATE3_2026-11-28.txt`

## 1. Périmètre de cette livraison

Cette archive est la livraison cumulative de l'étape 2, construite directement sur l'étape 1. Elle raccorde le registre partagé de remboursements automatiques aux parcours d'entrée BSC-USD et XTU et met en place le worker de paiement groupé idempotent. Elle ne constitue pas la fin du portage MAJ5/MAJ6 et n'est pas prête pour une mise en production.

## 2. Implémentations réalisées

### 2.1 Registre commun et catégories A à D

- Les transferts officiels BSC-USD et XTU provenant d'une adresse inconnue sont enregistrés dans le registre commun en catégorie A.
- Les événements BSC-USD reçus pendant la période globale, extension de réclamation comprise, sont classés en catégorie B.
- Les dépôts BSC-USD et XTU effectivement reçus mais non crédités d'un compte désactivé, ainsi que ses nouveaux transferts officiels, sont orientés vers la catégorie C.
- À l'expiration immuable de 30 jours d'un dossier d'achat BSC-USD actif n'ayant pas atteint 20 BSC-USD bruts dans au plus cinq événements, le principal source encore non crédité est transféré en catégorie D. La transition attend le rattrapage du scanner jusqu'à la frontière finalisée et ne modifie pas les réserves communes. Le compte reste actif.
- Les transferts sources restent exclusifs : une même source ne peut pas être à la fois créditée comme dépôt normal et remboursée par le registre partagé.

### 2.2 Règles communes d'éligibilité

- Le regroupement est limité au même réseau (Chain ID 56), contrat exact, token et adresse source.
- La destination du paiement est l'adresse source d'origine.
- Une retenue hors chaîne de 1 % est calculée par événement source.
- Chaque événement doit être finalisé et avoir franchi son délai propre de 30 minutes.
- Le gas estimé est déduit une seule fois par transaction groupée, avec plafond distinct de 0,4 BSC-USD.
- Le montant net minimal est fixé à 1 unité du token source. BSC-USD et XTU ne sont jamais mélangés.
- Les petits montants restent conservés sans échéance de 30 jours et sans statut de revue lié à l'ancienneté.

### 2.3 Worker de paiement automatique

Le nouveau `automatic-refund-worker.js` :

- sélectionne les groupes éligibles et réserve leurs événements dans une transaction SQL ;
- vérifie la liquidité token et BNB ainsi que les autres obligations déjà réservées ;
- persiste la transaction signée brute, son hash, son nonce et son portefeuille émetteur avant la diffusion ;
- vérifie que le signataire correspond exactement au portefeuille enregistré pour le paiement ;
- ne rediffuse qu'exactement la même transaction signée en cas d'absence de visibilité RPC ;
- vérifie la transaction, le reçu canonique, le nombre de confirmations et le transfert du token exact vers l'adresse source ;
- restaure une réservation après un échec on-chain définitif ;
- place les situations incertaines ou incohérentes en `manual_review` plutôt que de créer une seconde transaction ;
- rapproche le gas réel. Une estimation excédentaire crée une obligation résiduelle envers le même expéditeur et dans le même token ; un dépassement du gas estimé est supporté par OneX, sans débit rétroactif au bénéficiaire.

Le worker reste désactivé par défaut via `AUTOMATIC_REFUNDS_ENABLED=false`.

### 2.4 Inscription et synchronisation des scanners

`POST /app/signup` prend le verrou financier durable de l'adresse, vérifie la santé et le rattrapage des scanners BSC-USD et XTU jusqu'à une référence finalisée commune, puis recherche les obligations impayées. Une obligation en attente bloque l'inscription avec HTTP 423 et `auth: "refund_pending"`. Une preuve scanner ou blockchain indisponible échoue de manière fermée avec HTTP 503. Le bloc de référence est enregistré dans `registered_at_block` ; aucun événement de remboursement n'est transformé en dépôt par l'inscription.

Les scanners et workers de changement d'état utilisent le même verrou d'adresse lorsqu'ils ajoutent ou déplacent des événements, réservent un paiement, le confirment ou restaurent une réservation.

### 2.5 Flux historiques et XTU sans commission

- Les anciens endpoints publics de demande/challenge de remboursement retournent HTTP 410 ; le parcours normal ne demande ni demande utilisateur, ni signature de contrôle du portefeuille, ni approbation administrative préalable.
- Les anciens parcours administratifs restent uniquement pour les enregistrements historiques déjà issus de l'ancien workflow. Les nouveaux transferts éligibles sont routés vers le registre automatique.
- `OneXToken.sol` et les politiques/runtime XTU imposent une commission de transfert contractuelle de 0 %. Les événements d'audit doivent concorder : brut = net et fee = 0.
- Les montants en remboursement XTU non crédités et non couverts par un lot de custody sont protégés de la consolidation Hot Wallet ; les remboursements réservés dans le Distribution Wallet sont protégés des autres retraits et règlements.
- La liquidité BSC-USD tient également compte des obligations de remboursement automatiques afin d'éviter leur double emploi par d'autres dépenses de trésorerie.

### 2.6 Reprise des dossiers désactivés

Les flux de dépôt BSC-USD et XTU effectuent périodiquement un balayage des dossiers encore non crédités associés à des comptes déjà désactivés. Cela permet de reprendre le routage catégorie C après un échec ponctuel de traitement de la demande de désactivation.

## 3. Fichiers et zones principales modifiés

- `automatic-refund-policy.js`
- `automatic-refund-service.js`
- `automatic-refund-worker.js` (nouveau)
- `routes.js`
- `pay.js`
- `db.js`
- `xtu-deposit-worker.js`
- `xtu-withdrawal-worker.js`
- `treasury-liquidity.js`
- `contracts/OneXToken.sol`
- `.env.example`, `README.md`
- `terms_fr.html`, `terms_en.html`, `privacy_fr.html`, `privacy_en.html`
- `android-integration/XTU_DEPOSITS.md`, `android-integration/XTU_EXTERNALIZATION.md`
- tests structurels et tests de règles de dépôts/remboursements adaptés à MAJ6.

Aucun script de migration SQL n'est ajouté : le projet doit être initialisé sur une base MySQL neuve, conformément à la spécification.

## 4. Vérifications exécutées

| Contrôle | Résultat |
|---|---:|
| `npm run check` — syntaxe JavaScript | 108 fichiers validés |
| Tests structurels ciblés (catégories, règles, signup, worker, liquidité, contrat XTU) | 31/31 réussis |
| Vérification statique du retrait des délais de revue liés aux petits remboursements | Réussie dans les tests ciblés |

Commandes utilisées pour les vérifications ciblées :

```bash
npm run check
node --test \
  tests/automatic-refund-stage2-structure.test.js \
  tests/deposit-pending-rules.test.js \
  tests/bsc-unknown-refund-request.test.js \
  tests/xtu-unknown-refunds-workflow.test.js \
  tests/stage1-schema.test.js
```

## 5. Limites et travaux restant obligatoires

Les dépendances du projet ne sont pas installées dans l'environnement (`bignumber.js`, `ethers`, `mysql2`, `solc` et `ganache` notamment). En conséquence :

- les tests arithmétiques et tests applicatifs qui chargent ces dépendances n'ont pas été exécutés ;
- aucune initialisation d'une base MySQL neuve n'a été exécutée ;
- aucun test d'intégration EVM/Ganache, aucune compilation Solidity et aucun transfert blockchain n'ont été exécutés ;
- les courses concurrentes, réorganisations, confirmations réelles, paiements incertains et rapprochements de gas restent à éprouver en environnement de test contrôlé.

`manual_review` demeure volontairement bloquant pour l'inscription. Cette étape n'ajoute pas d'interface administrative de résolution formelle ; il ne faut pas libérer ces obligations par modification directe de statut.

Le portage MAJ5 complet demeure pour l'étape 3, notamment :

- migration de tous les dépôts XTU vers le ledger XTU libre et ses règles MAJ5 (sans reprendre les anciennes règles d'achat BSC-USD) ;
- migration des disbursements individuel et global vers les soldes XTU libres, snapshots, réservations et règlements dédiés ;
- intégration complète de la qualification des essais à cinq transferts, de la désactivation provoquée par un sixième événement et de la désactivation après 360 jours sans activité financière admissible, avec ledger d'activité et notifications ;
- intégration de toutes les protections de réserves et exécution des tests MySQL/EVM réels sur une base neuve.

**Ne pas activer `AUTOMATIC_REFUNDS_ENABLED`, les workers de dépôts, les retraits XTU ou les workers de disbursement avec cette archive avant la validation complète de ces points.**
