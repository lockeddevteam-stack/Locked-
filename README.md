# locked- — public deployment mirror for LOCKED

This repository holds the **built** LOCKED app so that Vercel can fetch it at
build time. Development happens in the private repo
`lockeddevteam-stack/locked`; this is a publish target, not a place to edit.

## Why this exists

The Vercel project `locked` (which serves `locked-seven.vercel.app`) is not
connected to GitHub — its deployments were made with the Vercel CLI from a local
folder. Deploying through the API instead means the build has to pull the app
from somewhere publicly reachable, and a private repo needs credentials the
build does not have.

Nothing here is secret: these are exactly the files already served publicly at
`locked-seven.vercel.app`. The only key in the client is the Supabase anon key,
which is public by design.

## Recommended: replace this with a direct git connection

This mirror is a workaround. The cleaner setup is to connect the Vercel project
straight to the private repo:

1. Vercel dashboard → project **locked** → Settings → Git → Connect
   `lockeddevteam-stack/locked`, production branch
   `claude/pwa-locked-repo-setup-7nt4yc`.
2. Clear the project's Build Command and Output Directory (it is a static site).
3. Delete this mirror.

After that, every push deploys automatically and this repo is unnecessary.

## Updating the mirror by hand

```
cp index.html manifest.json sw.js vercel.json icon-*.png favicon.* <mirror>/
cp admin/index.html <mirror>/admin/
cd <mirror> && git add -A && git commit -m "Publish build" && git push
```

Then redeploy the Vercel project so the build re-fetches these files.
