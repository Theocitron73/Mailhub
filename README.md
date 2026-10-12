# MailHub

Messagerie de bureau (Windows et macOS) qui regroupe plusieurs boîtes mail IMAP et range
automatiquement les nouveaux messages dans vos dossiers.

## Ce que fait l'application

- **Plusieurs comptes IMAP** dans une seule fenêtre, avec une **boîte unifiée** qui mélange les boîtes de réception. Chaque compte a sa couleur.
- **Récupération des dossiers existants** de chaque serveur (Boîte de réception, Envoyés, Corbeille, dossiers personnels et sous-dossiers).
- **Création, renommage et suppression de dossiers** (bouton `+` d'un compte, ou clic droit sur un dossier).
- **Tri en un geste** : ouvrez un message, cliquez sur un onglet du bandeau « Ranger dans », ou glissez-le sur un dossier. Un message vous propose alors « Toujours ranger ici » : les prochains messages de cet expéditeur (ou de tout son domaine) iront dans ce dossier, et les messages déjà reçus peuvent être rangés en même temps.
- **Glisser-déposer = règle automatique** : glissez un message sur un dossier, il est rangé et une règle « de cette adresse → ce dossier » est créée. Une bulle permet d'**annuler la règle** ou de **ranger aussi les anciens messages** de cette adresse. Si une règle existe déjà pour l'adresse, elle est mise à jour (jamais dupliquée). Aucune règle n'est créée vers la Corbeille, les Brouillons, les Envoyés ou la Boîte de réception. Désactivable dans Réglages.
- **Disposition de lecture au choix**, comme Thunderbird : **à côté** de la liste, **en dessous**, ou **plein écran** (boutons au-dessus de la liste). Un double-clic sur un message l'ouvre en plein écran, quelle que soit la disposition ; `Échap` revient à la liste. La séparation se règle à la souris (double-clic pour rétablir) et la taille est mémorisée.
- **Import des filtres Thunderbird** : Règles → « Importer depuis Thunderbird ». Le profil est trouvé automatiquement (ou choisissez un `msgFilterRules.dat`). Un aperçu indique quels filtres sont repris ; les dossiers manquants peuvent être créés ; les doublons sont détectés.
- **Règles de tri** modifiables, avec ordre de priorité (la première règle qui correspond s'applique ; boutons « Appliquer plus tôt / plus tard ») : expéditeur, destinataire, objet ou domaine, avec « toutes les conditions » ou « au moins une ».
- **Surveillance en temps réel** (IMAP IDLE) : les nouveaux messages sont triés dès leur arrivée. Le courrier reçu pendant que l'application était fermée est trié au démarrage suivant.
- Lecture HTML sécurisée, pièces jointes, recherche, étoile, lu / non lu, suppression (vers la corbeille), réponse, transfert et envoi de messages (SMTP).
- Thème clair, sombre ou automatique.

Raccourcis : `j` / `k` (message suivant / précédent), `m` (ranger), `r` (répondre), `u` (lu / non lu), `Suppr` (supprimer).

## Installer l'application

### Option 1 : fabriquer les installateurs avec GitHub (recommandé)

Un installateur macOS ne peut être construit que sur un Mac, et un installateur Windows de façon fiable que sur Windows.
Le dépôt contient donc un workflow GitHub Actions qui les construit pour vous :

1. Créez un dépôt GitHub et envoyez-y ce dossier.
2. Onglet **Actions**, workflow **Installateurs MailHub**, bouton **Run workflow**.
3. Une fois terminé, téléchargez `MailHub-Setup-1.0.0.exe` (Windows) et `MailHub-1.0.0-universal.dmg` (macOS, Intel et Apple Silicon) dans les artefacts.

En poussant un tag (`git tag v1.0.0 && git push --tags`), les installateurs sont aussi publiés dans l'onglet **Releases**.

### Option 2 : construire sur votre machine

Prérequis : [Node.js 22](https://nodejs.org/).

```bash
npm install
npm run dist:win   # sur Windows  -> dist/MailHub-Setup-1.0.0.exe
npm run dist:mac   # sur macOS    -> dist/MailHub-1.0.0-universal.dmg
```

### Lancer en développement

```bash
npm install
npm start
npm test   # moteur de règles + lecture des filtres Thunderbird
```

## Premier lancement : avertissements du système

Les installateurs ne sont **pas signés** tant que vous n'avez pas de certificat, donc :

- **Windows** affiche « Windows a protégé votre ordinateur » (SmartScreen) : cliquez sur *Informations complémentaires*, puis *Exécuter quand même*.
- **macOS** refuse d'ouvrir l'application téléchargée : faites un clic droit sur MailHub, *Ouvrir*, puis *Ouvrir*. Si macOS la déclare « endommagée », exécutez dans le Terminal : `xattr -cr /Applications/MailHub.app`.

### Signature (pour supprimer ces avertissements)

- Windows : un certificat de signature de code. Ajoutez les secrets `CSC_LINK` (certificat .pfx encodé en base64) et `CSC_KEY_PASSWORD` au dépôt, puis passez-les en variables d'environnement à l'étape de build du workflow.
- macOS : un compte Apple Developer (99 $ par an) avec un certificat « Developer ID Application », puis la notarisation. Voir <https://www.electron.build/code-signing>.

## Ajouter un compte

Cliquez sur **Ajouter un compte**. Pour les fournisseurs courants (Gmail, iCloud, Yahoo, Orange, Free, SFR, La Poste, GMX, Zoho, Fastmail, Proton via Bridge), les serveurs se remplissent seuls.

**Mot de passe d'application obligatoire** pour Gmail, iCloud et Yahoo : créez-en un dans la sécurité de votre compte (la validation en deux étapes doit être active) et utilisez-le à la place du mot de passe habituel.

## Limites connues

- **Outlook.com, Hotmail et Microsoft 365** n'acceptent plus les mots de passe pour IMAP : ils exigent OAuth2, qui n'est pas encore pris en charge. Ces comptes ne se connecteront pas.
- Le tri automatique ne fonctionne que **si MailHub est en marche**. Sous Windows, fermer la fenêtre réduit l'application dans la zone de notification ; l'option « Lancer MailHub à l'ouverture de session » (Réglages) la démarre sans fenêtre.
- Le tri automatique ne surveille que la **boîte de réception** de chaque compte.
- L'éditeur de messages écrit en **texte brut** (pas de mise en forme, pas de brouillons enregistrés).
- Un message ne peut être rangé que dans un dossier **du même compte**.
- Les messages de plus de 25 Mo ne sont pas affichés.

- **Import Thunderbird** : seuls les filtres « déplacer vers un dossier » sont repris. Les critères sur le corps du message, la date, l'état, etc., et les autres actions (copier, étiqueter, transférer, supprimer…) sont signalés comme ignorés. Seuls les filtres de type « à l'arrivée » sont importés.

## Sécurité

- Les mots de passe sont chiffrés avec le Trousseau macOS ou la protection de données Windows (DPAPI) et ne sont jamais envoyés à l'interface.
- Sans SSL/TLS direct, le chiffrement STARTTLS est **exigé** : MailHub refuse d'envoyer un mot de passe en clair.
- Les e-mails HTML s'affichent dans un cadre isolé : aucun script, images distantes masquées par défaut, liens ouverts dans votre navigateur.
- L'interface n'a pas accès à Node.js (isolation du contexte et bac à sable activés).
- Les données locales (comptes, règles) sont dans le dossier de données de l'application, par exemple `%APPDATA%\MailHub` sous Windows et `~/Library/Application Support/MailHub` sous macOS.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `main.js` | Fenêtre, icône de notification, canaux IPC, notifications |
| `preload.js` | Pont sécurisé entre l'interface et le processus principal |
| `src/imap.js` | Connexions IMAP, dossiers, messages, surveillance IDLE, tri, envoi SMTP |
| `src/rules.js` | Moteur de règles de tri (sans dépendance, testé) |
| `src/store.js` | Comptes, règles, préférences, chiffrement des mots de passe |
| `renderer/` | Interface (HTML, CSS, JavaScript, polices embarquées) |

Polices : Instrument Sans et Fraunces, sous licence SIL Open Font License.
