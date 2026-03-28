# iD editor: more custom background slots

Userscript that adds extra editable background tile URL slots to the [OpenStreetMap iD editor](https://www.openstreetmap.org/edit), alongside the built-in single "Custom" background.

![Screenshot of iD editor with three custom background slots](./image-20260328012458213.png)

**Disclaimer:** This was entirely vibe-coded with [Cursor](https://cursor.com/) and [Claude Code](https://claude.com/claude-code). I do not assert copyright over it, barely know JavaScript, and have not verified that it is safe. Use at your own risk.

Related upstream discussion:

- [openstreetmap/iD#8874](https://github.com/openstreetmap/iD/issues/8874): Add Custom 1, 2, 3 Backgrounds
- [openstreetmap/iD#10055](https://github.com/openstreetmap/iD/issues/10055): Possibility to use more that one custom layer on ID editor

## Install

**Firefox only.** Chrome is not currently supported — OpenStreetMap's Content Security Policy prevents the hook from working in Chrome.

1. Install [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/) (or Tampermonkey) for Firefox.
2. Click the link below to install the script directly:
   **[Install iD-editor-more-custom-slots.user.js](https://raw.githubusercontent.com/endolith/iD-editor-more-custom-slots/main/iD-editor-more-custom-slots.user.js)**

## Usage

Open the [iD editor](https://www.openstreetmap.org/edit). In the **Background** panel, extra slots appear next to the built-in **Custom** entry (labelled "Custom 1", "Custom 2", etc.). Click the **⋯** button next to any slot to set its name and tile URL template in the same was as for the regular **Custom** slot.  The name of the slot will be updated to match the name you set.  You can now switch between backgrounds much more easily.

## Development

### Releases

Bump `// @version` in the header and `SCRIPT_VERSION` inside the script to the same value. Also update `@updateURL` / `@downloadURL` if the branch or filename ever changes.

### How it works

The script uses `GM_addElement` to inject its payload as a real `<script>` element, which is needed because OSM's Content Security Policy (`script-src 'self' + nonce`) blocks Tampermonkey from running in the page's JS world directly. Without this, `window.iD` is never the real iD object.

Once in the page, the script hooks `window.iD` before iD assigns it, wrapping the namespace in a `Proxy`. The proxy intercepts reads of `iD.coreContext` — which is a non-configurable getter on the iD object (so `Object.defineProperty` can't replace it) — and substitutes a wrapper that captures the live context when `context.init()` runs. From there it splices extra `rendererBackgroundSource` entries into iD's shared `_imageryIndex` singleton and patches the background list DOM to add ⋯ edit buttons.

A late fallback (polling for the background pane button) handles cases where the early Proxy hook missed.

**Chrome is unsupported** despite several attempts: OSM's CSP and how Tampermonkey falls back to the isolated extension world (where `window.iD` is not the page's iD) make the hook fail. `GM_addElement` was tried and did not fix it on Chrome.

### Troubleshooting

In the browser console (on `openstreetmap.org/id`), check `window.__iDExtraBg`. If `hooked` is `false` after the editor loads, the script did not attach — try reinstalling or check the console for errors.
