# Store badge assets

Both files are the vendors' own artwork, committed here rather than hot-linked
because both vendors say to host them yourself, and because GitHub proxies
README images through camo — an asset that moves upstream breaks the README
permanently.

| File | Source | Terms |
|---|---|---|
| `chrome-web-store-badge.png` | [Chrome Web Store branding guidelines](https://developer.chrome.com/docs/webstore/branding) — "large PNG (with border)", 496×150 | No pre-approval needed. Do not modify beyond resizing; preserve the aspect ratio; keep it legible and fully visible; do not make it the primary element of the page; it must link to the live listing. |
| `firefox-get-the-addon.svg` | Mozilla Add-ons "Get the Add-on" button, 172×60 ([addons.mozilla.org blog](https://blog.mozilla.org/addons/2020/04/16/get-the-add-on-buttons/)) | Mozilla publishes it for self-hosting and asks that it link to the AMO listing page, not to a raw `.xpi`. |

The with-border Chrome variant is deliberate: the borderless one is transparent
with dark text and disappears on GitHub's dark theme. The bordered one carries
its own white plate and reads on both.

Displayed at `height="60"` in the root `README.md`, which is a downscale for the
Chrome badge (496×150 → 198×60) and 1:1 for Firefox.
