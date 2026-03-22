// ==UserScript==
// @name         iD Editor: Multiple Custom Backgrounds
// @namespace    https://github.com/endolith
// @version      0.1.1
// @description  Adds multiple editable custom tile URL slots to the iD editor background list.
// @homepageURL  https://github.com/openstreetmap/iD/issues/10055
// @match        *://www.openstreetmap.org/edit*
// @match        *://www.openstreetmap.org/id*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

// HOW IT WORKS
// ─────────────────────────────────────────────────────────────────────────────
// @inject-into page — REQUIRED (Violentmonkey / Tampermonkey). User scripts default
// to an isolated "content" world where window.iD does not exist and where
// stopImmediatePropagation does not block OSM's page-world DOMContentLoaded handler.
// Page injection runs in the same JS realm as iD and id.js.
//
// OSM registers its iD initialization on DOMContentLoaded. Because this script
// runs at document-start, our DOMContentLoaded listener is registered *first*
// and therefore fires before OSM's. We:
//   1. Stop the natural DOMContentLoaded from reaching OSM's handler.
//   2. Wrap window.iD.coreContext() to intercept context initialization.
//   3. Dispatch a fresh DOMContentLoaded so OSM initializes with our wrapped
//      version and everything else (other scripts) still works normally.
//
// Inside the hook, after iD's UI is ready, we push extra rendererBackgroundSource
// objects into iD's imagery index — the same internal API the Strava Heatmap
// extension uses. Each slot gets a ⋯ edit button appended to its list item via
// MutationObserver, mirroring iD's own Custom background entry.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // ── User-configurable ─────────────────────────────────────────────────────
    const NUM_SLOTS = 3;   // how many extra Custom slots to add
    // ─────────────────────────────────────────────────────────────────────────

    const STORAGE_KEY = 'iD-extra-bg-slots';
    const ID_PREFIX   = 'custom-extra-';

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
        const original = iDObj.coreContext;
        iDObj.coreContext = function () {
            const context = original.apply(this, arguments);
            const originalInit = context.init;
            context.init = function () {
                const result = originalInit.apply(this, arguments);
                _context = context;
                // Wait for iD's UI to finish bootstrapping before touching imagery.
                context.ui().ensureLoaded().then(() => applySlots(context));
                return result;
            };
            return context;
        };
    }

    // ── Inject custom background sources ─────────────────────────────────────

    async function applySlots(context) {
        const background = context.background();
        const imagery    = await background.ensureLoaded();

        // Snapshot and clear active overlays so re-init doesn't double-toggle them
        // (same pattern used by the Strava Heatmap extension).
        const activeOverlayIds = background.overlayLayerSources().map(s => s.id);
        background.overlayLayerSources().forEach(s => background.toggleOverlayLayer(s));

        // Remove any slots we added in a previous call.
        imagery.backgrounds = imagery.backgrounds.filter(
            b => !b.id.startsWith(ID_PREFIX)
        );

        const slots    = loadSlots();
        const customIdx = imagery.backgrounds.findIndex(b => b.id === 'custom');
        const insertAt  = customIdx >= 0 ? customIdx : 0;

        // Insert in reverse so the final order is slot 0, slot 1, …, Custom.
        for (let i = slots.length - 1; i >= 0; i--) {
            const slot   = slots[i];
            const source = iD.rendererBackgroundSource({
                id:          `${ID_PREFIX}${i}`,
                name:        slot.name || `Custom ${i + 1}`,
                description: slot.template || 'No URL configured — click ⋯ to set',
                template:    slot.template || '',
                overlay:     false,
            });
            imagery.backgrounds.splice(insertAt, 0, source);
        }

        await background.init();
        if (!context.history().hasRestorableChanges()) {
            await context.ui().restart();
        }

        // Restore the overlays that were active before we wiped them.
        activeOverlayIds.forEach(id => {
            const source = background.findSource(id);
            if (source) background.toggleOverlayLayer(source);
        });

        // Patch any list items that are already in the DOM.
        patchBackgroundListDOM(context);
        installObserver(context);
    }

    // ── Inject ⋯ edit buttons into the background list ───────────────────────

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
            // Same SVG icon iD uses for its own Custom entry's ⋯ button.
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
        const existing = document.getElementById('extra-bg-edit-modal');
        if (existing) existing.remove();

        const slots = loadSlots();
        const slot  = slots[slotIndex];

        // Build the backdrop and modal using iD's own CSS classes so it inherits
        // iD's theming (colors, fonts, button styles, etc.) for free.
        const backdrop = document.createElement('div');
        backdrop.id        = 'extra-bg-edit-modal';
        backdrop.className = 'modal-wrap';
        Object.assign(backdrop.style, {
            position: 'fixed',
            inset:    '0',
            zIndex:   '10000',
            display:  'flex',
            alignItems:     'center',
            justifyContent: 'center',
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
                <div class="instructions-template" style="margin-bottom:10px;">
                    <label style="display:block;font-weight:bold;margin-bottom:4px;">Name</label>
                    <input id="ebg-name" type="text" value="${esc(slot.name)}"
                        autocomplete="off" spellcheck="false"
                        style="width:100%;padding:6px 8px;box-sizing:border-box;
                               border:1px solid #ccc;border-radius:3px;">
                </div>
                <div class="instructions-template">
                    <label style="display:block;font-weight:bold;margin-bottom:4px;">Tile URL Template</label>
                    <textarea id="ebg-template" class="field-template" rows="3"
                        placeholder="${esc(example)}"
                        autocomplete="off" spellcheck="false"
                        style="width:100%;padding:6px 8px;box-sizing:border-box;
                               border:1px solid #ccc;border-radius:3px;
                               font-family:monospace;resize:vertical;"
                    >${esc(slot.template)}</textarea>
                </div>
                <p style="font-size:12px;color:#888;margin:6px 0 0;">
                    TMS tiles: use <code>{x}</code>, <code>{y}</code>, <code>{z}</code>
                    or <code>{zoom}</code>.<br>
                    WMS layers: use <code>{proj}</code>, <code>{bbox}</code>,
                    <code>{width}</code>, <code>{height}</code>.
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

    // We are registered first (document-start), so this listener fires before
    // OSM's DOMContentLoaded handler. We intercept the natural event, set up the
    // hook, then re-dispatch so OSM's handler runs cleanly against our hooked iD.
    let _hooked = false;
    document.addEventListener('DOMContentLoaded', function onReady(e) {
        if (_hooked) return;

        if (typeof window.iD === 'undefined' || typeof window.iD.coreContext !== 'function') {
            console.error(
                '[iD-extra-backgrounds] window.iD.coreContext missing — enable page injection ' +
                '(Violentmonkey / Tampermonkey: @inject-into page).'
            );
            return;
        }

        _hooked = true;

        // Prevent OSM's handler from seeing the natural DOMContentLoaded.
        e.stopImmediatePropagation();

        wrapCoreContext(window.iD);

        // Fire a clean event so OSM's handler (and any other deferred init code)
        // runs as normal, now with our hook in place.
        document.dispatchEvent(
            new Event('DOMContentLoaded', { bubbles: true, cancelable: true })
        );
    });

})();
