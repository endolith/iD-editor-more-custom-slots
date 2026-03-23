// ==UserScript==
// @name         iD Editor: Multiple Custom Backgrounds
// @namespace    https://github.com/endolith
// @version      0.5.0
// @description  Adds multiple editable custom tile URL slots to the iD editor background list.
// @homepageURL  https://github.com/openstreetmap/iD/issues/10055
// @match        *://www.openstreetmap.org/id*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

// HOW IT WORKS
// ─────────────────────────────────────────────────────────────────────────────
// iD runs in an iframe at /id (not /edit). Read debug state from the parent:
//   document.getElementById('id-embed').contentWindow.__iDExtraBg
//
// TWO PATHS depending on when Violentmonkey injects relative to DOMContentLoaded:
//
// Early (readyState === 'loading'):
//   Register a *capture* DOMContentLoaded listener. It fires before OSM's
//   bubble-phase handler (which calls iD.coreContext()). We wrap coreContext
//   first so the context OSM creates has our hook baked in. After context.init()
//   we push extra rendererBackgroundSource entries and call ui().restart().
//
// Late (readyState !== 'loading' — events have already fired):
//   We missed the coreContext hook. iD's background module keeps a module-level
//   _imageryIndex singleton. We create a throwaway coreContext() just to call
//   background.ensureLoaded() (which returns the shared singleton), then splice
//   extra entries into imagery.backgrounds. We poll for the background pane
//   button to appear, then toggle it to force the list to re-render.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // ── User-configurable ─────────────────────────────────────────────────────
    const NUM_SLOTS = 3;   // how many extra Custom slots to add
    // ─────────────────────────────────────────────────────────────────────────

    const STORAGE_KEY = 'iD-extra-bg-slots';
    const ID_PREFIX   = 'custom-extra-';

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
        const insertAt  = customIdx >= 0 ? customIdx : 0;

        for (let i = slots.length - 1; i >= 0; i--) {
            const slot   = slots[i];
            const source = window.iD.rendererBackgroundSource({
                id:          `${ID_PREFIX}${i}`,
                name:        slot.name || `Custom ${i + 1}`,
                description: slot.template || 'No URL configured — click ⋯ to set',
                template:    slot.template || '',
                overlay:     false,
            });
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
        setTimeout(() => { if (wasOpen) btn.click(); }, 100);
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

    function wrapCoreContext(iDObj) {
        if (!iDObj || iDObj.__extraBgCoreContextWrapped) return;
        const original = iDObj.coreContext;
        if (typeof original !== 'function') return;
        iDObj.__extraBgCoreContextWrapped = true;
        dbg('coreContext wrapped');
        iDObj.coreContext = function () {
            const context = original.apply(this, arguments);
            const originalInit = context.init;
            context.init = function () {
                const result = originalInit.apply(this, arguments);
                _context = context;
                context.ui()
                    .ensureLoaded()
                    .then(() => applySlots(context))
                    .catch((err) =>
                        console.error('[iD-extra-bg] applySlots failed', err)
                    );
                return result;
            };
            return context;
        };
    }

    // Full apply via real context (early path): reinit background + restart UI.
    async function applySlots(context) {
        dbg('applySlots start');
        const background = context.background();
        const imagery    = await background.ensureLoaded();

        const activeOverlayIds = background.overlayLayerSources().map(sourceId);
        background.overlayLayerSources().forEach(s => background.toggleOverlayLayer(s));

        injectSlotsIntoImagery(imagery);

        await background.init();

        const restorable = context.history().hasRestorableChanges();
        dbg('hasRestorableChanges=', restorable);

        if (!restorable) {
            await new Promise(r => setTimeout(r, 0));
            await context.ui().restart();
            dbg('ui.restart() done');
        }

        activeOverlayIds.forEach(id => {
            const src = background.findSource(id);
            if (src) background.toggleOverlayLayer(src);
        });

        window.__iDExtraBg = {
            version: '0.5.0',
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
        while (!window.iD || typeof window.iD.coreContext !== 'function') {
            if (Date.now() - start > 20000) {
                window.__iDExtraBg.error = 'window.iD.coreContext never became available';
                console.error('[iD-extra-bg]', window.__iDExtraBg.error);
                return;
            }
            await new Promise(r => setTimeout(r, 50));
        }

        const imagery = await window.iD.coreContext().background().ensureLoaded();

        if (imagery.backgrounds.some(b => sourceId(b).startsWith(ID_PREFIX))) {
            dbg('slots already present in imagery (init-hook ran first)');
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
            version: '0.5.0',
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
    async function reapplyAfterSave() {
        const imagery = await window.iD.coreContext().background().ensureLoaded();
        injectSlotsIntoImagery(imagery);

        if (_context) {
            // Trigger the real background's change event so the list re-renders.
            const bg = _context.background();
            bg.baseLayerSource(bg.baseLayerSource());
        } else {
            toggleBackgroundPaneRefresh();
            await new Promise(r => setTimeout(r, 200));
        }

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
        slots.forEach((_, i) => {
            const radio = document.querySelector(
                `input[name="background-layer"][value="${ID_PREFIX}${i}"]`
            );
            if (!radio) return;
            const li = radio.closest('li');
            if (!li || li.dataset.extraBgPatched) return;
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

    function openEditDialog(slotIndex) {
        document.getElementById('extra-bg-edit-modal')?.remove();

        const slots = loadSlots();
        const slot  = slots[slotIndex];

        const backdrop = document.createElement('div');
        backdrop.id        = 'extra-bg-edit-modal';
        backdrop.className = 'modal-wrap';
        Object.assign(backdrop.style, {
            position: 'fixed', inset: '0', zIndex: '10000',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
        });

        const modal = document.createElement('div');
        modal.className = 'modal fillL';
        Object.assign(modal.style, { maxWidth: '560px', width: '90vw' });

        const example = 'https://tile.openstreetmap.org/{zoom}/{x}/{y}.png';
        modal.innerHTML = `
            <div class="modal-section header">
                <h3>Custom Background Settings</h3>
            </div>
            <div class="modal-section message-text">
                <div style="margin-bottom:10px;">
                    <label style="display:block;font-weight:bold;margin-bottom:4px;">Name</label>
                    <input id="ebg-name" type="text" value="${esc(slot.name)}"
                        autocomplete="off" spellcheck="false"
                        style="width:100%;padding:6px 8px;box-sizing:border-box;
                               border:1px solid #ccc;border-radius:3px;">
                </div>
                <div>
                    <label style="display:block;font-weight:bold;margin-bottom:4px;">Tile URL Template</label>
                    <textarea id="ebg-template" rows="3"
                        placeholder="${esc(example)}"
                        autocomplete="off" spellcheck="false"
                        style="width:100%;padding:6px 8px;box-sizing:border-box;
                               border:1px solid #ccc;border-radius:3px;
                               font-family:monospace;resize:vertical;"
                    >${esc(slot.template)}</textarea>
                </div>
                <p style="font-size:12px;color:#888;margin:6px 0 0;">
                    TMS: <code>{x}</code> <code>{y}</code> <code>{z}</code> or <code>{zoom}</code> &nbsp;·&nbsp;
                    WMS: <code>{proj}</code> <code>{bbox}</code> <code>{width}</code> <code>{height}</code>
                </p>
            </div>
            <div class="modal-section buttons">
                <button id="ebg-cancel" class="button cancel-button secondary-action">Cancel</button>
                <button id="ebg-save" class="button ok-button action">OK</button>
            </div>
        `;

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        const nameEl     = modal.querySelector('#ebg-name');
        const templateEl = modal.querySelector('#ebg-template');

        modal.querySelector('#ebg-cancel').addEventListener('click', () => backdrop.remove());
        backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
        modal.querySelector('#ebg-save').addEventListener('click', () => {
            slots[slotIndex] = {
                name:     nameEl.value.trim() || `Custom ${slotIndex + 1}`,
                template: templateEl.value.trim(),
            };
            saveSlots(slots);
            backdrop.remove();
            reapplyAfterSave().catch((err) =>
                console.error('[iD-extra-bg] reapplyAfterSave failed', err)
            );
        });

        nameEl.select();
        nameEl.focus();
    }

    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    window.__iDExtraBg = { version: '0.5.0', hooked: false };

    if (document.readyState === 'loading') {
        // DOMContentLoaded hasn't fired yet. Our capture listener fires before
        // OSM's bubble listener, which is when iD.coreContext() is called.
        window.__iDExtraBg.strategy = 'capture-DCL-pending';
        document.addEventListener('DOMContentLoaded', function () {
            dbg('capture DCL fired, window.iD type:', typeof window.iD);
            if (window.iD && typeof window.iD.coreContext === 'function') {
                wrapCoreContext(window.iD);
                window.__iDExtraBg.strategy = 'capture-DCL-hooked';
            } else {
                window.__iDExtraBg.error = 'window.iD not ready at capture DCL';
                console.error('[iD-extra-bg]', window.__iDExtraBg.error);
            }
        }, { capture: true, once: true });
    } else {
        // DOMContentLoaded (and probably load) already fired — OSM has already
        // called coreContext(). Use the shared imagery fallback immediately.
        window.__iDExtraBg.strategy = 'immediate-late-fallback';
        applySlotsLate().catch((err) =>
            console.error('[iD-extra-bg] applySlotsLate failed', err)
        );
    }

    dbg('bootstrap done, strategy=', window.__iDExtraBg.strategy,
        'readyState=', document.readyState);

})();
