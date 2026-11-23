# Mail providers

Philobiblos reads one mailbox used for nothing else (ADR 0007). Your own mail account forwards only the bookshop's mail
there with a filter, and Philobiblos reads one folder of it over IMAP, read-only, with TLS from the first byte. No
provider is built in. Whoever runs Philobiblos sets the mailbox up in the environment (`docker-compose.yml`), and an admin
connects it in Settings when it signs in with OAuth.

There are two ways to sign in:

- **An app password** (the default, `PHILOBIBLOS_IMAP_AUTH=password`). The provider gives you a password for one app, and
  you put it in `PHILOBIBLOS_IMAP_PASSWORD` (or a file named by `PHILOBIBLOS_IMAP_PASSWORD_FILE`). Use this whenever the
  provider offers it.
- **XOAUTH2** (`PHILOBIBLOS_IMAP_AUTH=xoauth2`), for providers that refuse passwords over IMAP. Philobiblos ships no OAuth
  client of its own. You register one with the provider, give Philobiblos its id (and its secret, if it has one) and the
  provider's endpoints, and an admin connects the mailbox in Settings. How it works is below the table.

## Which to use

The values below were checked against the providers' own documentation in November 2026. Providers change these
things, so check their pages before you rely on them.

| Provider | Sign in with | `PHILOBIBLOS_IMAP_HOST` |
|---|---|---|
| Gmail and Google Workspace | an app password (needs 2-Step Verification on the account), or XOAUTH2 when the account or its Workspace admin does not allow app passwords | `imap.gmail.com` |
| Microsoft (Outlook.com, Hotmail, Microsoft 365) | XOAUTH2: Microsoft no longer accepts passwords for IMAP | `outlook.office365.com` |
| Fastmail | an app password with IMAP access (Fastmail's OAuth is for its approved partners only) | `imap.fastmail.com` |
| mailbox.org | your password, or an app password if the account uses two-factor authentication | `imap.mailbox.org` |
| Self-hosted (Dovecot, Stalwart, …) | a password of an account made for Philobiblos | your server's name |
| Proton Mail | Proton Mail Bridge's own password (Proton has no IMAP of its own; see below) | where Bridge runs |

Turn IMAP on in the account's settings where the provider has a switch for it.

## XOAUTH2

You register an OAuth client with the provider, and you name its parts in the environment:

| Variable | What |
|---|---|
| `PHILOBIBLOS_IMAP_AUTH` | `xoauth2` |
| `PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID` | the client's id |
| `PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET` (or `…_SECRET_FILE`) | its secret, a secret like the IMAP password; leave it out for a public client |
| `PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL` | the provider's authorization endpoint (https), with any parameters of the provider's own it needs for a refresh token |
| `PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL` | its token endpoint (https) |
| `PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL` | its revocation endpoint (https, RFC 7009), if it has one |
| `PHILOBIBLOS_IMAP_OAUTH_SCOPE` | the scopes that allow IMAP, space-separated |

`PHILOBIBLOS_IMAP_PASSWORD` stays empty: a mailbox signs in one way, never with a fallback. A missing or malformed part
stops Philobiblos at start with the variable's name.

When you register the client, give the provider the **redirect URI** Settings shows (Settings, Mailbox):
`PHILOBIBLOS_ORIGIN` followed by `/settings/mail-oauth`, for example `https://books.example.org/settings/mail-oauth`. It
is the only one Philobiblos ever sends. The provider must redirect to an https address, or to `http://localhost` while
you try it out.

**Connecting.** An admin opens Settings, Mailbox, reads what connecting allows (the mailbox and folder, the host where
they sign in, the scope, where the tokens go) and chooses *Connect the mailbox*. This needs a sign-in of the last 10
minutes. The browser goes to the provider, where they sign in as the Philobiblos-only mailbox and allow the scope, and
comes back to Settings. Philobiblos exchanges the code with its PKCE verifier and seals the refresh and access tokens like
the delivery address. Under HomersLab, connecting waits for the edge to tell Philobiblos about a recent sign-in
(homeward#253), as enabling a bookshop does.

**Afterwards.** The mail job signs in with the access token and refreshes it when it has less than a minute left. A new
refresh token from the provider replaces the old one. When the provider no longer accepts the refresh token (it was
revoked, or it expired), Philobiblos forgets the tokens and the mail job says an admin should connect again. If you change
the client, its endpoints, the scope or the mailbox in the environment, the old tokens are never used or sent to the new
endpoints, and Settings asks for a new connection.

**Disconnecting** (Settings, Mailbox) forgets the tokens, then revokes the refresh token at the provider if it has a
revocation endpoint. A refresh still in flight when you disconnect writes nothing back, and if the provider answered it
with a new refresh token, that one is revoked too. Without a revocation endpoint, also remove Philobiblos from the
account's connected apps.

The scope decides what a token can reach. For IMAP that is usually the whole mailbox, which is one more reason to
connect only the mailbox Philobiblos uses and nothing else.

### Gmail and Google Workspace

In the Google Cloud console, make a project, set up its OAuth consent screen and create an OAuth client of the type
*Web application* with the redirect URI above. IMAP needs the scope `https://mail.google.com/`. Google treats it as a
restricted scope:

- A Workspace account can use an *Internal* app, which needs no review.
- A personal account can use an app in *Testing* with the mailbox added as a test user. Google lets the refresh tokens
  of a testing app expire after 7 days, and you then connect again in Settings. To avoid that, publish the app, which
  needs Google's verification, or use an app password.

```sh
PHILOBIBLOS_IMAP_HOST=imap.gmail.com
PHILOBIBLOS_IMAP_USER=books-mailbox@example.org
PHILOBIBLOS_IMAP_AUTH=xoauth2
PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID=…apps.googleusercontent.com
PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET_FILE=/run/secrets/imap-oauth-secret
# access_type=offline asks for a refresh token; prompt=consent asks for one again when you connect again.
PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL=https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent
PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL=https://oauth2.googleapis.com/token
PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL=https://oauth2.googleapis.com/revoke
PHILOBIBLOS_IMAP_OAUTH_SCOPE=https://mail.google.com/
```

### Microsoft (Outlook.com, Microsoft 365)

In the Microsoft Entra admin center, register an application with a *Web* redirect URI (the one above) and a client
secret. Its API permissions are *Office 365 Exchange Online* (`IMAP.AccessAsUser.All`, delegated) and `offline_access`.
Use the tenant's id instead of `common` for a work or school mailbox only, or `consumers` for Outlook.com only. Microsoft
rotates refresh tokens, and Philobiblos keeps the newest. It has no revocation endpoint for them: after disconnecting,
remove the app under the account's app permissions. A client secret expires at the date you chose when you made it.
Make a new one and connect again before then.

```sh
PHILOBIBLOS_IMAP_HOST=outlook.office365.com
PHILOBIBLOS_IMAP_USER=books-mailbox@example.org
PHILOBIBLOS_IMAP_AUTH=xoauth2
PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID=00000000-0000-0000-0000-000000000000
PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET_FILE=/run/secrets/imap-oauth-secret
PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL=https://login.microsoftonline.com/common/oauth2/v2.0/authorize
PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL=https://login.microsoftonline.com/common/oauth2/v2.0/token
PHILOBIBLOS_IMAP_OAUTH_SCOPE=https://outlook.office.com/IMAP.AccessAsUser.All offline_access
```

## Fastmail and mailbox.org

Both take an app password. In Fastmail's settings, make an app password whose access includes IMAP. For mailbox.org,
your account's password works, and with two-factor authentication on you make an app password in its settings instead.

```sh
PHILOBIBLOS_IMAP_HOST=imap.fastmail.com   # or imap.mailbox.org
PHILOBIBLOS_IMAP_USER=books-mailbox@example.org
PHILOBIBLOS_IMAP_PASSWORD_FILE=/run/secrets/imap-password
```

## Self-hosted

Make an account for Philobiblos on your own server and use its password. The server must speak IMAP over TLS from the
first byte (IMAPS, usually port 993). Philobiblos never uses STARTTLS. If the server's certificate is not from a public
CA, give Philobiblos that certificate (PEM, mounted read-only) in `PHILOBIBLOS_IMAP_CA_FILE`. It then trusts that
certificate and nothing else, and still checks that the certificate is for `PHILOBIBLOS_IMAP_HOST`. For another port,
set `PHILOBIBLOS_IMAP_PORT`; TLS still starts at the first byte.

XOAUTH2 against your own identity provider works too, if its token endpoint is on a public address over https.
Philobiblos's token client reaches public addresses only, as every outgoing request does (ADR 0009). **A token endpoint
only on your home network is not supported**, and that is a decision, not a gap: allowing private addresses for it
would let whoever sets the environment's token URL point Philobiblos's token client (which sends the client secret and
the refresh token) at the router, the edge or a neighbour container. Connecting then fails with *cannot reach … (private-address)*
and nothing is sent. Use an app password for such a server: the IMAP connection itself may be on the home network.

## Proton Mail, through Bridge

Proton Mail has no IMAP of its own. Proton Mail Bridge, Proton's app, offers the mailbox over IMAP on the computer it runs
on, with a password of its own that Bridge shows you. **Bridge needs a paid Proton plan**: a free account cannot use it.
That password goes in `PHILOBIBLOS_IMAP_PASSWORD`. Bridge has to keep running for Philobiblos to read mail.

Bridge listens on its own loopback address only (127.0.0.1), and its certificate names that address. In the shipped
`docker-compose.yml`, 127.0.0.1 inside Philobiblos's container is the container's own loopback, not the computer's, so
Bridge is not reached that way. Philobiblos has to share Bridge's network, in one of two ways:

- **Bridge on the computer, Philobiblos on the host's network.** Give the `philobiblos` service `network_mode: host`, drop
  its `ports:` (the host network does not take them) and **set `PHILOBIBLOS_HOST=127.0.0.1`**: on the host's network
  Philobiblos would otherwise listen on every interface of the computer (its default inside a container is 0.0.0.0),
  open to the home network past your proxy. 127.0.0.1 is then the computer's, where Bridge listens, and Philobiblos
  answers on the computer's own 127.0.0.1:8080, behind your proxy as before.
- **Bridge in a container of its own.** Give the `philobiblos` service `network_mode: "service:<bridge>"`, where `<bridge>`
  is the name of Bridge's service in the same compose file. Both then share one network namespace, so 127.0.0.1 is the
  same loopback for both. Move the `ports:` of `philobiblos` to Bridge's service, because only the service that owns the
  namespace can publish ports.

Then, as Philobiblos speaks TLS from the first byte only and checks the certificate's name:

1. In Bridge's settings, set the IMAP connection to SSL (not STARTTLS), and note its IMAP port.
2. Export Bridge's TLS certificate from its settings, mount the file read-only, and name it in `PHILOBIBLOS_IMAP_CA_FILE`.
3. Set `PHILOBIBLOS_IMAP_HOST` to the address the certificate names (check with
   `openssl x509 -in cert.pem -noout -ext subjectAltName`; usually 127.0.0.1).
4. Set `PHILOBIBLOS_IMAP_PORT` to Bridge's IMAP port.

```sh
PHILOBIBLOS_IMAP_HOST=127.0.0.1           # what Bridge's certificate names
PHILOBIBLOS_IMAP_PORT=1143                # Bridge's IMAP port, set to SSL
PHILOBIBLOS_IMAP_CA_FILE=/run/secrets/bridge-cert.pem
PHILOBIBLOS_IMAP_USER=books-mailbox@proton.example
PHILOBIBLOS_IMAP_PASSWORD_FILE=/run/secrets/bridge-password
```

Under HomersLab the manifest (`contracts/homerslab-app.yaml`) takes `PHILOBIBLOS_IMAP_PORT` (default 993; its egress
allows that port on `PHILOBIBLOS_IMAP_HOST`), so a server on another port works there. It also asks HomersLab to mount
the certificate for `PHILOBIBLOS_IMAP_CA_FILE` read-only at `/config/imap-ca.pem`, which HomersLab cannot do yet (a
NEEDS HomersLab note): until it can, a server with its own certificate works standalone only. Bridge does not work
under HomersLab yet either: HomersLab chooses the app's network itself and cannot share Bridge's loopback with it.
