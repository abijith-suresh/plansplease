---
title: Self-hosting
description: What you can run locally today and the status of a self-hosted cloud application.
---
## Local previews

The CLI and its preview server already run on your computer without an account.
[Install the CLI](../install-cli/), then publish a file or a folder:

```sh
plansplease publish --open ./page.html
plansplease publish --open ./my-page/
```

Documents stay in your local user profile. The preview server binds to localhost;
it is not a public web server or a way to share links with other devices.

## The cloud application

A supported self-hosted cloud installation is still being designed. There is no
Docker Compose installer or documented home-server installation to follow yet.

The repository cloud app uses Convex for accounts and metadata and UploadThing
for file storage. Hosting the app on your server alone does not replace those
services. Hosted service availability is in the
[features reference](../../reference/planned-features/).
The [self-hosting proposal](https://github.com/abijith-suresh/plansplease/pull/129)
covers storage adapters, authentication, backups and upgrades.

For contributor setup rather than a supported installation, see
[repository development](../../reference/development/) and
[architecture](../../reference/architecture/).
