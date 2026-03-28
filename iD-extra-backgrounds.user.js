// ==UserScript==
// @name         iD Editor: Multiple Custom Backgrounds
// @namespace    https://github.com/endolith
// @version      0.7.5
// @description  Adds multiple editable custom tile URL slots to the iD editor background list.
// @homepageURL  https://github.com/openstreetmap/iD/issues/10055
// @match        *://www.openstreetmap.org/id*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Bump releases: set `// @version` above and SCRIPT_VERSION in the IIFE to the same value
// (Violentmonkey / Greasy Fork only read the header; runtime code uses SCRIPT_VERSION).

// HOW IT WORKS
// ─────────────────────────────────────────────────────────────────────────────
// iD runs in an iframe at /id (not /edit). Read debug state from the parent:
//   document.getElementById('id-embed').contentWindow.__iDExtraBg
//
// TWO PATHS, both always attempted:
//
// NOTE: @inject-into page is intentionally absent. With that directive,
//   Tampermonkey injects via a <script> element which OSM's CSP blocks
//   (no unsafe-inline). Without it, Tampermonkey uses chrome.scripting
//   .executeScript({ world:"MAIN" }) which bypasses CSP and still runs in
//   the page context. Violentmonkey users: use @inject-into page if your
//   version handles CSP, otherwise use @inject-into content with unsafeWindow.
//
// Early (Proxy interceptor):
//   Intercepts the window.iD assignment and wraps the namespace object in a
//   Proxy. The Proxy intercepts reads of iD.coreContext and returns our
//   wrapped factory instead of the original.
//
//   WHY PROXY: iD exposes coreContext as a non-configurable getter property on
//   the namespace object. Direct assignment (iDObj.coreContext = fn) silently
//   fails. Object.defineProperty also fails (configurable: false). A Proxy
//   intercepts property reads without touching the underlying descriptor.
//
//   When OSM calls iD.coreContext(), our factory runs first, wraps context.init,
//   and returns the context. When init() fires we have the live context with a
//   fully initialized background() system, allowing us to inject slots and fire
//   background.baseLayerSource() to trigger a list re-render.
//
// Late (shared imagery fallback):
//   Triggered ONLY after iD's background UI button appears (guaranteeing iD is
//   fully initialized) AND the early hook hasn't fired. Accesses the shared
//   _imageryIndex singleton via a standalone rendererBackground instance,
//   splices extra entries into imagery.backgrounds, then toggles the background
//   pane to force a re-render. injectSlotsIntoImagery() is idempotent.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    /** Bumped together with `// @version` in the userscript header above. */
    const SCRIPT_VERSION = '0.7.5';

    // ── User-configurable ─────────────────────────────────────────────────────
    const NUM_SLOTS = 3;   // how many extra Custom slots to add
    // ─────────────────────────────────────────────────────────────────────────

    const STORAGE_KEY = 'iD-extra-bg-slots';
    const ID_PREFIX   = 'custom-extra-';

    // HTML equivalent of what iD produces by passing its core.yaml locale strings through marked().
    // iD source: modules/ui/settings/custom_background.js builds markdown (#### headings, * bullets,
    // `backtick` code spans) from data/core.yaml settings.custom_background.instructions, then calls
    // marked(). This is the verbatim HTML that results — do not summarize or elide.
    const ID_CUSTOM_BG_INSTRUCTIONS_HTML = `\
<p>Enter a tile URL template below.</p>
<h4>Supported WMS tokens:</h4>
<ul>
<li><code>{proj}</code>: requested projection (<code>EPSG:3857</code> only)</li>
<li><code>{wkid}</code>: same as proj, but without the EPSG (<code>3857</code> only)</li>
<li><code>{width}</code>, <code>{height}</code>: requested image dimensions (<code>256</code> only)</li>
<li><code>{bbox}</code>: requested bounding box (e.g. <code>minX,minY,maxX,maxY</code>)</li>
</ul>
<h4>Supported TMS tokens:</h4>
<ul>
<li><code>{zoom}</code> or <code>{z}</code>, <code>{x}</code>, <code>{y}</code>: Z/X/Y tile coordinates</li>
<li><code>{-y}</code> or <code>{ty}</code>: flipped TMS-style Y coordinates</li>
<li><code>{switch:a,b,c}</code>: DNS server multiplexing</li>
<li><code>{u}</code>: quadtile (Bing) scheme</li>
<li><code>{@2x}</code> or <code>{r}</code>: resolution scale factor</li>
</ul>
<h4>Example:</h4>
<p><code>https://tile.openstreetmap.org/{zoom}/{x}/{y}.png</code></p>`;

    const DEBUG = () => localStorage.getItem('iD-extra-bg-debug') === '1';
    function dbg(...args) {
        if (DEBUG()) console.log('[iD-extra-bg]', ...args);
    }

    function sourceId(b) {
        if (!b) return '';
        return typeof b.id === 'function' ? b.id() : (b.id || '');
    }

    // ── Slot persistence ──────────────────────────────────────────────────────

    function loadSlots() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                while (parsed.length < NUM_SLOTS) {
                    parsed.push({ name: `Custom ${parsed.length + 1}`, template: '' });
                }
                return parsed.slice(0, NUM_SLOTS);
            }
        } catch (_) {}
        return Array.from({ length: NUM_SLOTS }, (_, i) => ({
            name: `Custom ${i + 1}`,
            template: '',
        }));
    }

    function saveSlots(slots) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
    }

    // ── Shared imagery mutation ────────────────────────────────────────────────
    // iD's background.js keeps a module-level _imageryIndex singleton that all
    // rendererBackground instances share via ensureImageryIndex(). Mutating
    // imagery.backgrounds affects what every instance sees.

    function injectSlotsIntoImagery(imagery) {
        imagery.backgrounds = imagery.backgrounds.filter(
            b => !sourceId(b).startsWith(ID_PREFIX)
        );

        const slots = loadSlots();
        const customIdx = imagery.backgrounds.findIndex(b => sourceId(b) === 'custom');
        // Insert AFTER the built-in 'custom' entry so our slots appear next to it.
        // If 'custom' isn't found, append to the end.
        const insertAt  = customIdx >= 0 ? customIdx + 1 : imagery.backgrounds.length;

        for (let i = slots.length - 1; i >= 0; i--) {
            const slot   = slots[i];
            // Use _iDRaw to bypass the Proxy and avoid recursion.
            const source = _iDRaw.rendererBackgroundSource({
                id:          `${ID_PREFIX}${i}`,
                name:        slot.name || `Custom ${i + 1}`,
                description: slot.template || 'No URL configured — click ⋯ to set',
                template:    slot.template || '',
                overlay:     false,
            });
            // Override area so iD's background list sorts these to the bottom,
            // grouped with the built-in 'Custom' entry (which has area = -2).
            source.area = function () { return -2; };
            imagery.backgrounds.splice(insertAt, 0, source);
        }
        return slots;
    }

    // Close + reopen the Background pane so iD re-renders the list from imagery.
    function toggleBackgroundPaneRefresh() {
        const btn = document.querySelector('.map-pane-control.background-control button');
        if (!btn) return false;
        const wasOpen = !!document.querySelector('.map-pane.background-pane.shown');
        btn.click();
        setTimeout(() => { if (wasOpen) btn.click(); }, 150);
        return true;
    }

    // Poll until selector appears or timeout (ms), then resolve with element (or null).
    function waitForElement(selector, timeout = 30000) {
        return new Promise(resolve => {
            const found = document.querySelector(selector);
            if (found) { resolve(found); return; }
            const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
            const obs = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) { clearTimeout(timer); obs.disconnect(); resolve(el); }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
        });
    }

    // ── iD hook (early path) ──────────────────────────────────────────────────

    let _context = null;

    // Called by the Proxy when OSM reads iD.coreContext.
    // Wraps context.init so we get the live context the moment it's initialized.
    function wrappedCoreContext() {
        const context = _origCC.apply(this, arguments);
        const originalInit = context.init;
        context.init = function () {
            const result = originalInit.apply(this, arguments);
            _context = context;
            dbg('context.init hooked');
            context.ui()
                .ensureLoaded()
                .then(() => applySlots(context))
                .catch((err) =>
                    console.error('[iD-extra-bg] applySlots failed', err)
                );
            return result;
        };
        return context;
    }

    // Full apply via live context (early path): inject into shared imagery then
    // ping baseLayerSource so iD's background_list change listener runs
    // (updateLayerSelections: checked state, tooltips). New rows may still need
    // a pane refresh or map-driven reRender; late path uses toggleBackgroundPaneRefresh.
    async function applySlots(context) {
        dbg('applySlots start');
        const background = context.background();
        const imagery    = await background.ensureLoaded();

        injectSlotsIntoImagery(imagery);

        background.baseLayerSource(background.baseLayerSource());

        window.__iDExtraBg = {
            version: SCRIPT_VERSION,
            hooked: true,
            mode: 'init-hook',
            backgroundsLen: imagery.backgrounds.length,
        };

        patchBackgroundListDOM(context);
        installObserver(context);
        dbg('applySlots done', window.__iDExtraBg);
    }

    // Late apply via shared imagery (late path): mutate + pane toggle.
    async function applySlotsLate() {
        dbg('applySlotsLate start, readyState=', document.readyState);

        // Wait for window.iD if not yet available.
        const start = Date.now();
        while (!_iDRaw || typeof _iDRaw.coreContext !== 'function') {
            if (Date.now() - start > 20000) {
                window.__iDExtraBg.error = 'window.iD.coreContext never became available';
                console.error('[iD-extra-bg]', window.__iDExtraBg.error);
                return;
            }
            await new Promise(r => setTimeout(r, 50));
        }

        // Use _iDRaw to create a standalone background instance — avoids calling
        // wrappedCoreContext() which would produce an uninitialized context.
        const bg      = _iDRaw.rendererBackground(_iDRaw.coreContext());
        const imagery = await bg.ensureLoaded();

        if (imagery.backgrounds.some(b => sourceId(b).startsWith(ID_PREFIX))) {
            dbg('slots already present (init-hook ran first)');
            window.__iDExtraBg = Object.assign({}, window.__iDExtraBg, {
                hooked: true, mode: 'already-injected',
            });
            await waitForElement('.map-pane-control.background-control button');
            patchBackgroundListDOM(_context);
            installObserver(_context);
            return;
        }

        injectSlotsIntoImagery(imagery);

        window.__iDExtraBg = {
            version: SCRIPT_VERSION,
            hooked: true,
            mode: 'late-fallback',
            backgroundsLen: imagery.backgrounds.length,
        };

        // Wait for the background pane button then refresh the list.
        const btn = await waitForElement('.map-pane-control.background-control button');
        if (btn) {
            toggleBackgroundPaneRefresh();
            await new Promise(r => setTimeout(r, 200));
        }

        patchBackgroundListDOM(_context);
        installObserver(_context);
        dbg('applySlotsLate done', window.__iDExtraBg);
    }

    // Re-apply after a URL is saved in the edit dialog.
    // iD's background list only sets label text on D3 enter, not on change — so after
    // renaming a slot we must refresh the pane (or reload) for the radio label to update.
    async function reapplyAfterSave() {
        const bg      = _iDRaw.rendererBackground(_iDRaw.coreContext());
        const imagery = await bg.ensureLoaded();
        injectSlotsIntoImagery(imagery);

        if (_context) {
            const liveBg = _context.background();
            // Fire the live background's change event (same id) so iD syncs radio
            // checked state and tooltips to the updated source objects — see
            // background_list.js updateLayerSelections.
            liveBg.baseLayerSource(liveBg.baseLayerSource());
        }

        // patchBackgroundListDOM updates the label <span> text directly, which is
        // necessary because iD's drawListItems only sets the span on D3 enter (the
        // key is id+'---'+i, so existing rows are never re-entered). The old
        // toggleBackgroundPaneRefresh approach closed/reopened the pane but that only
        // hides/shows a CSS class — it does not destroy and recreate the list DOM.
        patchBackgroundListDOM(_context);
    }

    // ── DOM patching — edit buttons ───────────────────────────────────────────

    let _observer = null;

    function installObserver(context) {
        if (_observer) _observer.disconnect();
        _observer = new MutationObserver(() => patchBackgroundListDOM(context));
        _observer.observe(document.body, { childList: true, subtree: true });
    }

    function patchBackgroundListDOM(context) {
        const slots = loadSlots();
        slots.forEach((slot, i) => {
            const radio = document.querySelector(
                `input[name="background-layer"][value="${ID_PREFIX}${i}"]`
            );
            if (!radio) return;
            const li = radio.closest('li');
            if (!li) return;

            // iD's drawListItems sets the label <span> only on D3 *enter*, never on
            // update (it uses id+'---'+i as the key so existing rows are never re-entered
            // even when the pane is closed/reopened). Update the text directly so a rename
            // takes effect immediately without a page reload.
            // IMPORTANT: guard with a value check before writing — this function is called
            // from a MutationObserver (childList+subtree), and setting textContent replaces
            // the child text node, which would re-fire the observer and cause an infinite loop.
            const span = li.querySelector('label > span');
            const wantedName = slot.name || `Custom ${i + 1}`;
            if (span && span.textContent !== wantedName) span.textContent = wantedName;

            if (li.dataset.extraBgPatched) return;
            li.dataset.extraBgPatched = 'true';

            const btn = document.createElement('button');
            btn.className = 'layer-browse';
            btn.title     = 'Edit background URL';
            btn.setAttribute('aria-label', 'Edit background URL');
            btn.innerHTML = '<svg class="icon"><use xlink:href="#iD-icon-more"/></svg>';
            btn.addEventListener('click', e => {
                e.preventDefault();
                openEditDialog(i);
            });
            li.appendChild(btn);
        });
    }

    // ── Edit dialog ───────────────────────────────────────────────────────────
    // Match iD's uiModal + uiConfirm + uiSettingsCustomBackground structure so
    // bundled CSS (.shaded, .modal.fillL, .content, .settings-custom-background,
    // .instructions-template, .field-template) applies. Host under .ideditor like iD does.

    function openEditDialog(slotIndex) {
        document.getElementById('extra-bg-edit-modal')?.remove();

        const slots = loadSlots();
        const slot  = slots[slotIndex];

        const instructionsHtml = ID_CUSTOM_BG_INSTRUCTIONS_HTML;

        const shaded = document.createElement('div');
        shaded.id = 'extra-bg-edit-modal';
        shaded.className = 'shaded';
        shaded.addEventListener('click', (e) => {
            if (e.target === shaded) shaded.remove();
        });

        const modal = document.createElement('div');
        modal.className = 'modal fillL settings-modal settings-custom-background';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'close';
        closeBtn.setAttribute('title', 'Close');
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '<svg class="icon"><use xlink:href="#iD-icon-close"></use></svg>';
        closeBtn.addEventListener('click', () => shaded.remove());

        const content = document.createElement('div');
        content.className = 'content';
        content.innerHTML = `
<div class="modal-section header">
  <h3>Custom Background Settings</h3>
</div>
<div class="modal-section message-text">
  <p class="extra-bg-slot-intro">
    <strong>Display name</strong> (shown in the background list next to the radio button).
    After you click OK, the list refreshes once so the new name appears.
  </p>
  <input id="ebg-name" type="text" class="field" value="${esc(slot.name)}"
    autocomplete="off" spellcheck="false">
  <div class="instructions-template">${instructionsHtml}</div>
  <textarea id="ebg-template" class="field-template" rows="6"
    placeholder="Enter a url template."
    autocomplete="off" spellcheck="false">${esc(slot.template)}</textarea>
</div>
<div class="modal-section buttons cf">
  <button type="button" id="ebg-cancel" class="button cancel-button secondary-action">Cancel</button>
  <button type="button" id="ebg-save" class="button ok-button action">OK</button>
</div>
`;

        modal.appendChild(closeBtn);
        modal.appendChild(content);
        shaded.appendChild(modal);

        const host = document.querySelector('.ideditor') || document.querySelector('#id-container') || document.body;
        host.appendChild(shaded);

        const nameEl     = content.querySelector('#ebg-name');
        const templateEl = content.querySelector('#ebg-template');

        content.querySelector('#ebg-cancel').addEventListener('click', () => shaded.remove());
        content.querySelector('#ebg-save').addEventListener('click', () => {
            slots[slotIndex] = {
                name:     nameEl.value.trim() || `Custom ${slotIndex + 1}`,
                template: templateEl.value.trim(),
            };
            saveSlots(slots);
            shaded.remove();
            reapplyAfterSave().catch((err) =>
                console.error('[iD-extra-bg] reapplyAfterSave failed', err)
            );
        });

        templateEl.focus();
    }

    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    window.__iDExtraBg = { version: SCRIPT_VERSION, hooked: false, strategy: 'init' };

    // The raw (unwrapped) iD namespace — used in places that need direct access
    // to iD internals without going through the Proxy (e.g. late path, reapply).
    let _iDRaw  = null;
    // The original coreContext factory function, saved from the raw namespace.
    let _origCC = null;

    function _makeProxy(raw) {
        _iDRaw  = raw;
        _origCC = raw.coreContext;   // reads the non-configurable getter → the factory fn
        return new Proxy(raw, {
            get(target, prop) {
                if (prop === 'coreContext') return wrappedCoreContext;
                return target[prop];
            },
            set(target, prop, value) {
                target[prop] = value;
                return true;
            },
        });
    }

    if (window.iD) {
        // iD already set (unlikely at document-start, but handle it).
        window.__iDExtraBg.strategy = 'iD-already-present';
        dbg('window.iD already set at script start');
        const proxy = _makeProxy(window.iD);
        try {
            Object.defineProperty(window, 'iD', {
                configurable: true, enumerable: true, writable: true, value: proxy,
            });
        } catch (_) { window.iD = proxy; }
    } else {
        // Intercept the assignment of window.iD, then install the Proxy.
        window.__iDExtraBg.strategy = 'waiting-for-iD';
        let _proxy = null;
        Object.defineProperty(window, 'iD', {
            configurable: true, enumerable: true,
            get() { return _proxy; },
            set(val) {
                _proxy = _makeProxy(val);
                // Restore window.iD as a plain writable property (pointing to the
                // Proxy) so iD's own internal accesses work without hitting our setter
                // again.
                try {
                    Object.defineProperty(window, 'iD', {
                        configurable: true, enumerable: true, writable: true,
                        value: _proxy,
                    });
                } catch (_) {}
                window.__iDExtraBg.strategy = 'proxy-installed';
                dbg('window.iD intercepted, Proxy installed');
            },
        });
    }

    // Late-path fallback: only triggers after iD's background UI button is
    // visible (guaranteeing iD is fully initialized) AND the early hook hasn't
    // fired. This avoids calling coreContext() while iD is still mid-init.
    const _lateCheck = setInterval(() => {
        if (window.__iDExtraBg.hooked) { clearInterval(_lateCheck); return; }
        if (!document.querySelector('.map-pane-control.background-control button')) return;
        clearInterval(_lateCheck);
        dbg('early hook missed — triggering late fallback');
        window.__iDExtraBg.strategy += '+late-fallback';
        applySlotsLate().catch(err => console.error('[iD-extra-bg] applySlotsLate failed', err));
    }, 500);
    setTimeout(() => clearInterval(_lateCheck), 120000);

    dbg('bootstrap done, strategy=', window.__iDExtraBg.strategy,
        'readyState=', document.readyState);

})();
