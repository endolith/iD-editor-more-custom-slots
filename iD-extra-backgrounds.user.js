// ==UserScript==
// @name         iD Editor: Multiple Custom Backgrounds
// @namespace    https://github.com/endolith
// @version      0.3.0
// @description  Adds multiple editable custom tile URL slots to the iD editor background list.
// @homepageURL  https://github.com/openstreetmap/iD/issues/10055
// @match        *://www.openstreetmap.org/id*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

// HOW IT WORKS
// ─────────────────────────────────────────────────────────────────────────────
// The iD editor on openstreetmap.org is NOT in the main page at /edit — it
// runs inside an <iframe> whose src is /id (a separate HTML page). That is
// why previous versions that matched /edit* always saw window.iD === undefined.
//
// This script matches /id* so it runs inside the iframe itself. With
// @inject-into page the script runs directly in the iframe's JavaScript
// context (same realm as window.iD). id.js is loaded synchronously from
// <head>, so by the time DOMContentLoaded fires, window.iD is already set.
//
// At document-start we register a *capture* DOMContentLoaded listener. It
// fires before OSM's bubble-phase listener (which calls iD.coreContext()).
// We wrap coreContext first, so the context OSM creates already has our
// hook in place. Then, after context.init() runs, we push extra
// rendererBackgroundSource entries into iD's imagery array — exactly like
// the Strava Heatmap extension — and call ui().restart() to rebuild the
// Background panel.
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

    // ── iD hook ───────────────────────────────────────────────────────────────

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

    // ── Inject custom background sources ──────────────────────────────────────

    async function applySlots(context) {
        dbg('applySlots start');
        const background = context.background();
        const imagery    = await background.ensureLoaded();

        // Clear overlays before re-init (Strava pattern).
        const activeOverlayIds = background.overlayLayerSources().map(sourceId);
        background.overlayLayerSources().forEach(s => background.toggleOverlayLayer(s));

        // Remove previous extra slots.
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

        await background.init();

        const restorable = context.history().hasRestorableChanges();
        dbg('hasRestorableChanges=', restorable);

        if (!restorable) {
            // Safe to restart — no pending edits from a previous session.
            await new Promise(r => setTimeout(r, 0));
            await context.ui().restart();
            dbg('ui.restart() done');
        }

        window.__iDExtraBg = {
            version: '0.3.0',
            hooked: true,
            backgroundsLen: imagery.backgrounds.length,
            slotIds: slots.map((_, i) => `${ID_PREFIX}${i}`),
        };

        activeOverlayIds.forEach(id => {
            const src = background.findSource(id);
            if (src) background.toggleOverlayLayer(src);
        });

        patchBackgroundListDOM(context);
        installObserver(context);
        dbg('applySlots done', window.__iDExtraBg);
    }

    // ── Inject ⋯ edit buttons ─────────────────────────────────────────────────

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
                openEditDialog(context, i);
            });
            li.appendChild(btn);
        });
    }

    // ── Edit dialog ───────────────────────────────────────────────────────────

    function openEditDialog(context, slotIndex) {
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
            if (_context) applySlots(_context);
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

    window.__iDExtraBg = {
        version: '0.3.0',
        hooked: false,
        note: 'Check this in the iD iframe context (select the frame in DevTools), not the parent page.',
    };

    // Capture phase fires before OSM's bubble-phase DOMContentLoaded handler.
    // By the time DOMContentLoaded fires, id.js has already run synchronously
    // from <head> and window.iD is defined.
    document.addEventListener('DOMContentLoaded', function () {
        dbg('DOMContentLoaded — window.iD type:', typeof window.iD);
        if (!window.iD || typeof window.iD.coreContext !== 'function') {
            window.__iDExtraBg.error = 'window.iD not found at DOMContentLoaded';
            console.error('[iD-extra-bg]', window.__iDExtraBg.error);
            return;
        }
        wrapCoreContext(window.iD);
        window.__iDExtraBg.hooked = true;
    }, { capture: true, once: true });

    dbg('bootstrap: capture listener registered, waiting for DOMContentLoaded');

})();
