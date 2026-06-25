// ===================================================================
// Planificator trasee curieri — logică principală
// Geocodare: Nominatim (OpenStreetMap) · Rutare: OSRM (router.project-osrm.org)
// ===================================================================

const COURIER_COLORS = ['#FF5A1F', '#8B5CF6', '#1D7FBF', '#2D6A4F', '#C2347E', '#B8860B'];

const state = {
  couriers: [],      // {id, name, start:{address,lat,lng}, end:{address,lat,lng}, color}
  addresses: [],      // {id, raw, details, clientName, phone, amount, paymentMethod, lat, lng, status:'pending'|'ok'|'error', courierId:null}
  routes: {},         // courierId -> {order:[addressId...], legs:[{distKm,durMin}], totalKm, totalMin}
  routeSelection: new Set(), // address ids currently checked in the Trasee tab, for bulk move
  nextCourierId: 1,
  nextAddrId: 1,
};

const PAYMENT_METHODS = ['Ramburs', 'Revolut', 'OP'];

let map, markersLayer, routeLinesLayer;

// -------------------------------------------------------------------
// INIT
// -------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initCourierPanel();
  initAddressPanel();
  initRoutePanel();
  initActionBar();
  setDateStamp();
  addCourier(); // start with one courier by default
});

function setDateStamp(){
  const d = new Date();
  const fmt = d.toLocaleDateString('ro-RO', { weekday:'long', day:'numeric', month:'long' });
  document.getElementById('dateStamp').textContent = `Manifest de livrare · ${fmt}`;
}

function showToast(msg, isError=false){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// -------------------------------------------------------------------
// MAP
// -------------------------------------------------------------------
function initMap(){
  map = L.map('map', { zoomControl:true }).setView([45.9432, 24.9668], 7); // Romania default
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap, © CARTO'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  routeLinesLayer = L.layerGroup().addTo(map);
}

function updateMapTopBar(){
  const geocoded = state.addresses.filter(a => a.status === 'ok').length;
  document.getElementById('mapSub').textContent = `${geocoded} adrese · ${state.couriers.length} curieri`;
  const hasRoutes = Object.keys(state.routes).length > 0;
  document.getElementById('mapTitle').textContent = hasRoutes ? 'Trasee active' : 'Niciun traseu activ';
}

// -------------------------------------------------------------------
// TABS
// -------------------------------------------------------------------
function initTabs(){
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  });
}

function switchToTab(panelId){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === panelId));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === panelId));
}

// -------------------------------------------------------------------
// COURIERS
// -------------------------------------------------------------------
function initCourierPanel(){
  document.getElementById('addCourierBtn').addEventListener('click', () => {
    addCourier();
    renderCouriers();
  });
}

function addCourier(){
  const id = state.nextCourierId++;
  const color = COURIER_COLORS[(id - 1) % COURIER_COLORS.length];
  state.couriers.push({
    id,
    name: `Curier ${id}`,
    start: { address: '', lat: null, lng: null, status: 'pending' },
    end: { address: '', lat: null, lng: null, status: 'pending' },
    sameAsStart: true,
    departureTime: '10:00', // HH:MM, used to compute delivery time windows
    endTimeLimit: '',       // optional HH:MM, only used for a visual warning if a stop falls after it
    confirmed: false,       // true once the courier's fields have been validated via the confirm button
    color
  });
  renderCouriers();
}

function removeCourier(id){
  state.couriers = state.couriers.filter(c => c.id !== id);
  state.addresses.forEach(a => { if (a.courierId === id) a.courierId = null; });
  delete state.routes[id];
  renderCouriers();
  renderAddresses();
  renderRouteSummary();
  redrawMap();
}

/**
 * Validates a single courier's configuration and marks it as confirmed if everything checks
 * out. Reads directly from the DOM first (same approach as ensureAllCourierPointsGeocoded)
 * so it also catches fields the user typed but never blurred out of.
 */
async function confirmCourier(courierId){
  const courier = state.couriers.find(c => c.id === courierId);
  if (!courier) return;

  // sync DOM -> state for this courier's fields, geocoding the start/end if needed
  const card = document.querySelector(`[data-confirm="${courierId}"]`)?.closest('.courier-card');
  if (card){
    const startInput = card.querySelector('.start-input');
    const endInput = card.querySelector('.end-input');
    const departureInput = card.querySelector('.departure-input');
    const endLimitInput = card.querySelector('.endlimit-input');

    if (startInput && startInput.value.trim() !== courier.start.address){
      courier.start.address = startInput.value.trim();
      courier.start.status = 'pending';
      courier.start.lat = null;
      courier.start.lng = null;
    }
    if (endInput && endInput.value.trim() !== courier.end.address){
      courier.end.address = endInput.value.trim();
      courier.end.status = 'pending';
      courier.end.lat = null;
      courier.end.lng = null;
    }
    if (departureInput) courier.departureTime = normalizeTime(departureInput.value);
    if (endLimitInput) courier.endTimeLimit = endLimitInput.value.trim() ? normalizeTime(endLimitInput.value) : '';
  }

  const btn = document.querySelector(`[data-confirm="${courierId}"]`);
  if (btn){ btn.disabled = true; btn.textContent = 'Se validează…'; }

  for (const pointKey of ['start', 'end']){
    const point = courier[pointKey];
    if (point.address && point.status === 'pending'){
      const result = await geocodeOne(point.address);
      if (result && result.outOfArea){
        point.status = 'error';
      } else if (result){
        point.lat = result.lat;
        point.lng = result.lng;
        point.status = 'ok';
      } else {
        point.status = 'error';
      }
    }
  }

  // run validation checks
  const errors = [];
  if (!courier.name.trim()) errors.push('numele curierului');
  if (!courier.start.address) errors.push('punctul de plecare');
  else if (courier.start.status === 'error') errors.push('punctul de plecare nu a putut fi localizat — verifică adresa');
  if (!courier.sameAsStart){
    if (!courier.end.address) errors.push('punctul de finalizare');
    else if (courier.end.status === 'error') errors.push('punctul de finalizare nu a putut fi localizat — verifică adresa');
  }
  if (!courier.departureTime) errors.push('ora de plecare');

  if (errors.length){
    courier.confirmed = false;
    showToast(`Nu pot confirma ${courier.name}: completează ${errors.join(', ')}.`, true);
  } else {
    courier.confirmed = true;
    showToast(`${courier.name} a fost confirmat.`);
  }

  renderCouriers();
}

function renderCouriers(){
  const list = document.getElementById('courierList');
  document.getElementById('courierCount').textContent = state.couriers.length;
  list.innerHTML = '';

  state.couriers.forEach(c => {
    const card = document.createElement('div');
    card.className = 'courier-card';

    const assignedCount = state.addresses.filter(a => a.courierId === c.id).length;
    const route = state.routes[c.id];
    const assignedAddrs = state.addresses.filter(a => a.courierId === c.id);
    const totalToCollect = assignedAddrs.reduce((sum, a) => sum + (a.amount || 0), 0);

    card.innerHTML = `
      <div class="courier-head">
        <span class="courier-dot" style="background:${c.color}"></span>
        <input type="text" class="courier-name-input" value="${escapeHtml(c.name)}"
          style="border:none;background:none;font-weight:600;font-size:13.5px;flex:1;font-family:inherit;color:inherit;padding:2px 0;">
        ${c.confirmed ? '<span class="courier-confirmed-badge" title="Curier confirmat">✓ confirmat</span>' : ''}
        <button class="btn-icon" title="Șterge curier" data-remove="${c.id}">×</button>
      </div>
      <div class="courier-body">
        <div class="courier-point-block">
          <div class="field" style="margin-bottom:6px;">
            <label>Punct de plecare</label>
            <input type="text" class="start-input" data-courier="${c.id}" placeholder="ex: Depozit, Str. Industriilor 5, București" value="${escapeHtml(c.start.address)}">
          </div>
          <div class="field" style="margin-bottom:0; max-width:120px;">
            <label>Ora de plecare</label>
            <input type="text" class="departure-input" data-courier="${c.id}" placeholder="10:00" value="${escapeHtml(c.departureTime || '')}">
          </div>
        </div>

        <div class="courier-point-block">
          <div class="field" style="margin-bottom:6px;">
            <label style="display:flex; justify-content:space-between; align-items:center;">
              <span>Punct de finalizare</span>
              <span style="text-transform:none; font-weight:400; display:flex; align-items:center; gap:4px;">
                <input type="checkbox" data-same="${c.id}" ${c.sameAsStart ? 'checked' : ''} style="margin:0;"> identic cu plecarea
              </span>
            </label>
            <input type="text" class="end-input" data-courier="${c.id}" placeholder="ex: acasă, sediu, alt depozit"
              value="${escapeHtml(c.end.address)}" style="${c.sameAsStart ? 'display:none;' : ''}">
          </div>
          <div class="field" style="margin-bottom:0; max-width:140px;">
            <label>Ora limită (opțional)</label>
            <input type="text" class="endlimit-input" data-courier="${c.id}" placeholder="18:00" value="${escapeHtml(c.endTimeLimit || '')}">
          </div>
        </div>

        <button class="btn ${c.confirmed ? 'btn-confirmed' : 'btn-accent'} btn-block btn-sm" data-confirm="${c.id}" style="margin-bottom:10px;">
          ${c.confirmed ? '✓ Curier confirmat' : 'Confirmă curier'}
        </button>

        <div class="stat-row">
          <div class="stat">
            <span class="stat-num" style="color:${c.color}">${assignedCount}</span>
            <span class="stat-label">Adrese</span>
          </div>
          <div class="stat">
            <span class="stat-num">${route ? route.totalKm.toFixed(1) : '—'}</span>
            <span class="stat-label">Km traseu</span>
          </div>
          <div class="stat">
            <span class="stat-num">${route ? formatMinutes(route.totalMin) : '—'}</span>
            <span class="stat-label">Durată</span>
          </div>
        </div>
        ${totalToCollect > 0 ? `
        <div style="margin-top:8px; padding-top:8px; border-top:1px solid var(--line-soft); font-size:11.5px; font-family:'JetBrains Mono',monospace; color:var(--ink-soft);">
          de încasat: <strong style="color:var(--ink);">${totalToCollect.toFixed(2)} lei</strong>
        </div>` : ''}
      </div>
    `;
    list.appendChild(card);
  });

  // wire events
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeCourier(parseInt(btn.dataset.remove)));
  });
  list.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', () => confirmCourier(parseInt(btn.dataset.confirm)));
  });
  list.querySelectorAll('.courier-name-input').forEach((input, i) => {
    input.addEventListener('change', () => {
      state.couriers[i].name = input.value || `Curier ${state.couriers[i].id}`;
      state.couriers[i].confirmed = false;
      renderCouriers();
      renderRouteSummary();
      redrawMap();
    });
  });
  list.querySelectorAll('.start-input').forEach(input => {
    input.addEventListener('change', () => onCourierAddressChange(input, 'start'));
  });
  list.querySelectorAll('.end-input').forEach(input => {
    input.addEventListener('change', () => onCourierAddressChange(input, 'end'));
  });
  list.querySelectorAll('[data-same]').forEach(cb => {
    cb.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(cb.dataset.same));
      courier.sameAsStart = cb.checked;
      courier.confirmed = false;
      renderCouriers();
    });
  });
  list.querySelectorAll('.departure-input').forEach(input => {
    input.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
      const normalized = normalizeTime(input.value);
      courier.departureTime = normalized;
      courier.confirmed = false;
      input.value = normalized;
      renderCouriers();
    });
  });
  list.querySelectorAll('.endlimit-input').forEach(input => {
    input.addEventListener('change', () => {
      const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
      const normalized = input.value.trim() ? normalizeTime(input.value) : '';
      courier.endTimeLimit = normalized;
      courier.confirmed = false;
      input.value = normalized;
      renderCouriers();
      renderRouteSummary(); // re-check warnings against new limit
    });
  });
}

async function onCourierAddressChange(input, which){
  const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
  const addr = input.value.trim();
  courier[which].address = addr;
  courier[which].lat = null;
  courier[which].lng = null;
  courier[which].status = 'pending';
  courier.confirmed = false;
  if (!addr){ renderCouriers(); return; }

  input.style.opacity = '0.6';
  const result = await geocodeOne(addr);
  input.style.opacity = '1';
  if (result && result.outOfArea){
    courier[which].status = 'error';
    showToast(`"${addr}" se localizează în afara zonei București/Ilfov.`, true);
  } else if (result){
    courier[which].lat = result.lat;
    courier[which].lng = result.lng;
    courier[which].status = 'ok';
  } else {
    courier[which].status = 'error';
    showToast(`Nu am putut localiza: "${addr}"`, true);
  }
  renderCouriers();
}

// -------------------------------------------------------------------
// ADDRESSES — import
// -------------------------------------------------------------------
function initAddressPanel(){
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  document.getElementById('addManualBtn').addEventListener('click', () => {
    showManualAddForm();
  });

  document.getElementById('geocodeBtn').addEventListener('click', () => geocodeAllPending());
  document.getElementById('manageVerifiedDbBtn').addEventListener('click', () => showVerifiedDbManager());
  updateVerifiedDbCounter();
}

function updateVerifiedDbCounter(){
  const el = document.getElementById('verifiedDbCount');
  if (el) el.textContent = countVerifiedAddresses();
}

function showVerifiedDbManager(){
  const db = loadVerifiedAddressDB();
  const entries = Object.entries(db).sort((a, b) => (b[1].savedAt || '').localeCompare(a[1].savedAt || ''));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:480px;">
      <div class="modal-title">Bază adrese verificate (${entries.length})</div>
      <div class="hint" style="margin-bottom:10px;">Aceste adrese sunt recunoscute automat la viitoare importuri, fără să mai treacă prin geocodare. Șterge o intrare dacă a fost salvată cu o poziție greșită.</div>
      <div id="verifiedDbList" style="max-height:50vh; overflow-y:auto;">
        ${entries.length ? entries.map(([key, entry]) => `
          <div class="verified-db-row" data-key="${escapeHtml(key)}">
            <div class="verified-db-text">
              <div class="verified-db-addr">${escapeHtml(entry.originalText || key)}</div>
              <div class="verified-db-coords">${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}</div>
            </div>
            <button class="addr-remove" data-remove-verified="${escapeHtml(key)}" title="Șterge din bază">×</button>
          </div>
        `).join('') : '<div class="hint">Baza este goală — nu există încă adrese salvate.</div>'}
      </div>
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-ghost btn-sm" id="vdbCloseBtn" style="flex:1;">Închide</button>
        ${entries.length ? '<button class="btn btn-sm" id="vdbClearAllBtn" style="flex:1; border-color:var(--danger); color:var(--danger);">Șterge tot</button>' : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('vdbCloseBtn').addEventListener('click', close);

  overlay.querySelectorAll('[data-remove-verified]').forEach(btn => {
    btn.addEventListener('click', () => {
      const db = loadVerifiedAddressDB();
      delete db[btn.dataset.removeVerified];
      saveVerifiedAddressDB(db);
      btn.closest('.verified-db-row').remove();
      updateVerifiedDbCounter();
    });
  });

  const clearAllBtn = document.getElementById('vdbClearAllBtn');
  if (clearAllBtn){
    clearAllBtn.addEventListener('click', () => {
      if (!confirm('Sigur vrei să ștergi toate adresele din baza verificată? Această acțiune nu poate fi anulată.')) return;
      saveVerifiedAddressDB({});
      updateVerifiedDbCounter();
      close();
    });
  }
}

function showEditAddressForm(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">Editează adresa</div>
      <div class="field" style="margin-bottom:7px;">
        <label>Nume client</label>
        <input type="text" id="eaName" value="${escapeHtml(addr.clientName)}">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Telefon</label>
        <input type="text" id="eaPhone" value="${escapeHtml(addr.phone)}">
      </div>
      <div class="field" style="margin-bottom:7px;">
        <label>Adresă (oraș, stradă, nr)</label>
        <input type="text" id="eaAddress" value="${escapeHtml(addr.raw)}">
        <div class="hint">Dacă schimbi adresa, va trebui re-localizată pe hartă.</div>
      </div>
      <label style="display:flex; align-items:center; gap:6px; margin-bottom:7px; font-size:12px; font-weight:500; cursor:pointer;">
        <input type="checkbox" id="eaAllowOutOfArea" ${addr.allowOutOfArea ? 'checked' : ''} style="margin:0;">
        Permite în afara zonei București/Ilfov (adresă excepțională, confirmată manual)
      </label>
      <div class="field" style="margin-bottom:7px;">
        <label>Detalii (bloc/scară/ap/interfon)</label>
        <input type="text" id="eaDetails" value="${escapeHtml(addr.details)}">
      </div>
      <div class="field-row" style="margin-bottom:7px;">
        <div class="field">
          <label>Sumă (lei)</label>
          <input type="text" id="eaAmount" value="${addr.amount != null ? addr.amount : ''}">
        </div>
        <div class="field">
          <label>Metodă plată</label>
          <select id="eaPayment">
            ${PAYMENT_METHODS.map(m => `<option value="${m}" ${addr.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}
            ${addr.paymentMethod && !PAYMENT_METHODS.includes(addr.paymentMethod) ? `<option value="${escapeHtml(addr.paymentMethod)}" selected>${escapeHtml(addr.paymentMethod)}</option>` : ''}
          </select>
        </div>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Notă client</label>
        <input type="text" id="eaNote" value="${escapeHtml(addr.customerNote)}">
      </div>
      <div style="display:flex; gap:6px; margin-top:14px;">
        <button class="btn btn-ghost btn-sm" id="eaCancelBtn" style="flex:1;">Anulează</button>
        <button class="btn btn-primary btn-sm" id="eaSaveBtn" style="flex:1;">Salvează</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('eaAddress').focus();

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('eaCancelBtn').addEventListener('click', close);

  document.getElementById('eaSaveBtn').addEventListener('click', async () => {
    const newAddressInput = document.getElementById('eaAddress').value.trim();
    if (!newAddressInput){
      showToast('Adresa este obligatorie.', true);
      return;
    }
    const newAddress = /rom[aâ]nia/i.test(newAddressInput) ? newAddressInput : `${newAddressInput}, România`;
    const newAllowOutOfArea = document.getElementById('eaAllowOutOfArea').checked;
    const addressChanged = newAddress !== addr.raw;
    const allowFlagChanged = newAllowOutOfArea !== addr.allowOutOfArea;

    addr.clientName = document.getElementById('eaName').value.trim();
    addr.phone = document.getElementById('eaPhone').value.trim();
    addr.details = document.getElementById('eaDetails').value.trim();
    addr.amount = parseAmount(document.getElementById('eaAmount').value);
    addr.paymentMethod = document.getElementById('eaPayment').value;
    addr.customerNote = document.getElementById('eaNote').value.trim();
    addr.raw = newAddress;
    addr.allowOutOfArea = newAllowOutOfArea;

    if (addressChanged || (allowFlagChanged && addr.status === 'error')){
      addr.lat = null;
      addr.lng = null;
      addr.status = 'pending';
      addr.confidence = null;
      addr.manuallyAdjusted = false;
      addr.outOfArea = false;
      // this address is no longer valid in any route until re-geocoded
      Object.keys(state.routes).forEach(courierId => {
        const route = state.routes[courierId];
        const i = route.order.indexOf(addr.id);
        if (i !== -1){
          route.order.splice(i, 1);
          if (route.order.length) recalcRouteDistance(parseInt(courierId));
          else delete state.routes[courierId];
        }
      });
    }

    close();
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    maybeShowGeocodeButton();
    redrawMap();

    // re-geocode immediately so the user sees the result of the new flag right away,
    // instead of waiting for the next bulk "Localizează adresele" / auto-assign pass
    if (addr.status === 'pending'){
      showToast('Se re-localizează adresa…');
      const result = await geocodeOne(addr.raw, addr.allowOutOfArea);
      if (result && result.outOfArea){
        addr.status = 'error';
        addr.confidence = null;
        addr.outOfArea = true;
        showToast('Adresa este în afara zonei București/Ilfov. Bifează "permite în afara zonei" dacă vrei să o accepți.', true);
      } else if (result){
        addr.lat = result.lat;
        addr.lng = result.lng;
        addr.status = 'ok';
        addr.confidence = result.confidence;
        addr.outOfArea = !isWithinServiceArea(result.lat, result.lng);
        if (result.confidence === 'high' && !addr.outOfArea){
          saveVerifiedAddress(addr.raw, result.lat, result.lng);
        }
        showToast(addr.outOfArea ? 'Adresă localizată în afara zonei (permis manual).' : 'Adresă re-localizată cu succes.');
      } else {
        addr.status = 'error';
        addr.confidence = null;
        showToast('Nu am putut localiza adresa.', true);
      }
      renderAddresses();
      renderCouriers();
      maybeShowGeocodeButton();
      redrawMap();
    }
  });
}

function showManualAddForm(){
  const picker = document.getElementById('columnPicker');
  picker.style.display = 'block';
  picker.innerHTML = `
    <div style="margin-bottom:8px; font-weight:600; color:var(--ink); text-transform:none; font-size:12.5px;">Adaugă adresă manual</div>
    <div class="field" style="margin-bottom:7px;">
      <label>Nume client</label>
      <input type="text" id="maName" placeholder="ex: Ana Popescu">
    </div>
    <div class="field" style="margin-bottom:7px;">
      <label>Telefon</label>
      <input type="text" id="maPhone" placeholder="ex: 07xx xxx xxx">
    </div>
    <div class="field" style="margin-bottom:7px;">
      <label>Adresă (oraș, stradă, nr)</label>
      <input type="text" id="maAddress" placeholder="ex: Cluj-Napoca, Str. Mihai Eminescu, 10">
    </div>
    <div class="field" style="margin-bottom:7px;">
      <label>Detalii (bloc/scară/ap/interfon)</label>
      <input type="text" id="maDetails" placeholder="ex: Bloc A2, et 3, ap 12, interfon 12">
    </div>
    <div class="field-row" style="margin-bottom:7px;">
      <div class="field">
        <label>Sumă (lei)</label>
        <input type="text" id="maAmount" placeholder="ex: 150">
      </div>
      <div class="field">
        <label>Metodă plată</label>
        <select id="maPayment">
          ${PAYMENT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="display:flex; gap:6px; margin-top:4px;">
      <button class="btn btn-ghost btn-sm" id="maCancelBtn" style="flex:1;">Anulează</button>
      <button class="btn btn-primary btn-sm" id="maConfirmBtn" style="flex:1;">Adaugă</button>
    </div>
  `;
  document.getElementById('maAddress').focus();
  document.getElementById('maCancelBtn').addEventListener('click', () => { picker.style.display = 'none'; });
  document.getElementById('maConfirmBtn').addEventListener('click', () => {
    const addressInput = document.getElementById('maAddress').value.trim();
    if (!addressInput){
      showToast('Adresa este obligatorie.', true);
      return;
    }
    const address = /rom[aâ]nia/i.test(addressInput) ? addressInput : `${addressInput}, România`;
    addAddress({
      raw: address,
      details: document.getElementById('maDetails').value.trim(),
      clientName: document.getElementById('maName').value.trim(),
      phone: document.getElementById('maPhone').value.trim(),
      amount: parseAmount(document.getElementById('maAmount').value),
      paymentMethod: document.getElementById('maPayment').value
    });
    picker.style.display = 'none';
    renderAddresses();
    switchToTab('panel-adrese');
    maybeShowGeocodeButton();
  });
}

function handleFile(file){
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')){
    Papa.parse(file, {
      complete: res => onParsedRows(res.data),
      skipEmptyLines: true
    });
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')){
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });
      onParsedRows(rows);
    };
    reader.readAsArrayBuffer(file);
  } else {
    showToast('Format neacceptat. Folosește CSV sau XLSX.', true);
  }
}

function onParsedRows(rows){
  if (!rows || !rows.length){
    showToast('Fișierul este gol.', true);
    return;
  }
  showColumnMapper(rows);
}

const FIELD_DEFS = [
  { key: 'orderNumber', label: 'Nr. Comandă', required: false, patterns: /order.?number|nr\.?\s*comand/i },
  { key: 'firstName', label: 'Prenume', required: false, patterns: /first.?name|prenume/i },
  { key: 'lastName', label: 'Nume', required: false, patterns: /last.?name|^nume$|de familie/i },
  { key: 'phone', label: 'Telefon', required: false, patterns: /phone|telefon|tel\b|mobil/i },
  { key: 'city', label: 'Oraș', required: false, patterns: /^city|ora[sș]|localitate/i },
  { key: 'street', label: 'Stradă', required: true, patterns: /^strada$|^street$|^stradă$/i },
  { key: 'number', label: 'Număr', required: false, patterns: /^nr\.?$|^number$|num[aă]r/i },
  { key: 'details', label: 'Detalii (bloc/scară/ap)', required: false, patterns: /detalii|detail|^bloc$|scar[aă]|interfon/i },
  { key: 'paymentMethod', label: 'Metodă de plată', required: false, patterns: /payment.?method|metod[aă].*plat[aă]|modalitate/i },
  { key: 'amount', label: 'Sumă de plată', required: false, patterns: /amount|total|sum[aă]|valoare|pret|preț/i },
  { key: 'customerNote', label: 'Notă client', required: false, patterns: /customer.?note|not[aă].*client|observa/i },
];

function guessColumnMapping(header){
  const mapping = {};
  FIELD_DEFS.forEach(field => {
    const idx = header.findIndex(h => field.patterns.test(String(h)));
    mapping[field.key] = idx !== -1 ? idx : null;
  });
  return mapping;
}

function showColumnMapper(rows){
  const picker = document.getElementById('columnPicker');
  const numCols = rows[0].length;
  // assume first row is a header if it has text-like, non-numeric cells and there's more than one row
  const looksLikeHeader = rows.length > 1 && rows[0].every(c => isNaN(parseFloat(c)) || c === '');
  const header = looksLikeHeader ? rows[0].map(h => String(h)) : rows[0].map((_, i) => `Coloana ${i+1}`);
  const guess = guessColumnMapping(header);

  const colOptions = (selectedIdx) => {
    let opts = `<option value="">— nefolosit —</option>`;
    header.forEach((h, i) => {
      opts += `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>${escapeHtml(h)}</option>`;
    });
    return opts;
  };

  picker.style.display = 'block';
  picker.innerHTML = `
    <div style="margin-bottom:8px; font-weight:600; color:var(--ink); text-transform:none; font-size:12.5px;">
      Asociază coloanele din fișier
    </div>
    <label style="display:flex; align-items:center; gap:5px; margin-bottom:9px; font-weight:400; text-transform:none;">
      <input type="checkbox" id="hasHeaderCb" ${looksLikeHeader ? 'checked' : ''}> prima linie este antet
    </label>
    ${FIELD_DEFS.map(field => `
      <div class="field" style="margin-bottom:7px;">
        <label>${field.label}${field.required ? ' *' : ''}</label>
        <select id="map_${field.key}" style="width:100%; padding:7px; border:1px solid var(--line); border-radius:2px; font-family:inherit; font-size:13px;">
          ${colOptions(guess[field.key])}
        </select>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-block btn-sm" id="confirmColBtn" style="margin-top:6px;">Importă ${rows.length - (looksLikeHeader ? 1 : 0)} rânduri</button>
  `;

  document.getElementById('confirmColBtn').addEventListener('click', () => {
    const hasHeader = document.getElementById('hasHeaderCb').checked;
    const startIdx = hasHeader ? 1 : 0;
    const colMap = {};
    FIELD_DEFS.forEach(field => {
      const val = document.getElementById(`map_${field.key}`).value;
      colMap[field.key] = val === '' ? null : parseInt(val);
    });

    if (colMap.street === null){
      showToast('Trebuie să selectezi coloana cu strada.', true);
      return;
    }

    const getCell = (row, key) => colMap[key] !== null ? String(row[colMap[key]] ?? '').trim() : '';

    let imported = 0;
    for (let i = startIdx; i < rows.length; i++){
      const row = rows[i];

      const firstName = getCell(row, 'firstName');
      const lastName = getCell(row, 'lastName');
      const clientName = [firstName, lastName].filter(Boolean).join(' ');

      const city = normalizeCityForGeocoding(getCell(row, 'city'));
      const streetRaw = getCell(row, 'street');
      const number = getCell(row, 'number');
      const details = getCell(row, 'details');
      if (!streetRaw) continue;

      const street = normalizeStreetPrefix(streetRaw);
      const streetPart = [street, number].filter(Boolean).join(' ');
      const fullAddress = [streetPart, city, 'România'].filter(Boolean).join(', ');

      addAddress({
        orderNumber: getCell(row, 'orderNumber'),
        raw: fullAddress,
        details,
        clientName,
        phone: getCell(row, 'phone'),
        amount: colMap.amount !== null ? parseAmount(row[colMap.amount]) : null,
        paymentMethod: colMap.paymentMethod !== null ? normalizePaymentMethod(row[colMap.paymentMethod]) : '',
        customerNote: getCell(row, 'customerNote')
      });
      imported++;
    }
    picker.style.display = 'none';
    renderAddresses();
    switchToTab('panel-adrese');
    maybeShowGeocodeButton();
    showToast(`${imported} adrese importate.`);
  });
}

function parseAmount(val){
  if (val === null || val === undefined || val === '') return null;
  const cleaned = String(val).replace(/[^\d.,-]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function normalizePaymentMethod(val){
  const str = String(val || '').trim();
  if (!str) return '';
  const lower = str.toLowerCase();
  // try exact match first
  const exact = PAYMENT_METHODS.find(m => m.toLowerCase() === lower);
  if (exact) return exact;
  // try contains match (e.g. "Plata prin Revolut" -> "Revolut")
  const contains = PAYMENT_METHODS.find(m => lower.includes(m.toLowerCase()));
  if (contains) return contains;
  return str; // keep original text if it doesn't match known options
}

function addAddress(data){
  state.addresses.push({
    id: state.nextAddrId++,
    orderNumber: data.orderNumber || '',
    raw: data.raw,
    details: data.details || '',
    clientName: data.clientName || '',
    phone: data.phone || '',
    amount: data.amount ?? null,
    paymentMethod: data.paymentMethod || '',
    customerNote: data.customerNote || '',
    lat: null,
    lng: null,
    status: 'pending',
    confidence: null,        // 'high' | 'medium' | 'low' | null — geocoding precision indicator
    manuallyAdjusted: false, // true once the pin has been dragged to a corrected position
    outOfArea: false,        // true if geocoding only found results outside the Bucharest/Ilfov service area
    allowOutOfArea: false,   // true if the user explicitly opted in to allow this address outside the service area
    courierId: null,
    manuallyAssigned: false  // true once the courier was set explicitly via the reassign dropdown
  });
}

function maybeShowGeocodeButton(){
  const section = document.getElementById('geocodeSection');
  const btn = document.getElementById('geocodeBtn');
  const statusRow = document.getElementById('geocodeStatus');
  const pending = state.addresses.filter(a => a.status === 'pending').length;
  if (pending > 0){
    section.style.display = 'block';
    statusRow.style.display = 'none';
    btn.style.display = 'block';
    btn.textContent = `Localizează ${pending} ${pending === 1 ? 'adresă' : 'adrese'}`;
  } else if (state.addresses.length > 0){
    section.style.display = 'block';
    statusRow.style.display = 'none';
    btn.style.display = 'none';
  } else {
    section.style.display = 'none';
  }
}

// -------------------------------------------------------------------
// ADDRESSES — render / list interactions / drag-drop
// -------------------------------------------------------------------
function renderAddresses(){
  const list = document.getElementById('addrList');
  if (!state.addresses.length){
    list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">▦</div>
        <div class="es-title">Nicio adresă încărcată</div>
        <div class="es-sub">Importă un fișier CSV/Excel sau adaugă manual</div>
      </div>`;
    return;
  }

  list.innerHTML = '';
  state.addresses.forEach((a, idx) => {
    const item = document.createElement('div');
    item.className = 'addr-item';
    item.draggable = true;
    item.dataset.id = a.id;

    let statusHtml = '';
    if (a.status === 'pending') statusHtml = `<div class="addr-status">în așteptare</div>`;
    else if (a.status === 'ok'){
      if (a.outOfArea && a.allowOutOfArea){
        statusHtml = `<div class="addr-status warn">⚠ în afara zonei București/Ilfov (permis manual) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else if (a.outOfArea){
        statusHtml = `<div class="addr-status warn">⚠ poziție în afara zonei București/Ilfov <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else if (a.confidence === 'verified'){
        statusHtml = `<div class="addr-status ok">✓ din baza de adrese verificate</div>`;
      } else if (a.manuallyAdjusted){
        statusHtml = `<div class="addr-status ok">✓ poziție ajustată manual</div>`;
      } else if (a.confidence === 'high'){
        statusHtml = `<div class="addr-status ok">✓ localizată precis</div>`;
      } else if (a.confidence === 'medium'){
        statusHtml = `<div class="addr-status warn">⚠ aproximativ (nivel stradă) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      } else {
        statusHtml = `<div class="addr-status warn">⚠ incert (nivel zonă) <button class="addr-locate-btn" data-locate="${a.id}">verifică pe hartă</button></div>`;
      }
    }
    else if (a.status === 'error'){
      statusHtml = a.outOfArea
        ? `<div class="addr-status err">✕ în afara zonei (București/Ilfov) <button class="addr-action-link" data-edit="${a.id}" style="font-size:10.5px;">corectează</button></div>`
        : `<div class="addr-status err">✕ neidentificată</div>`;
    }

    const courier = state.couriers.find(c => c.id === a.courierId);
    const courierSelect = `
      <select class="addr-courier-select" data-id="${a.id}" style="border-color:${courier ? courier.color : 'var(--line)'}; color:${courier ? courier.color : 'var(--ink-soft)'};">
        <option value="">— nerepartizat —</option>
        ${state.couriers.map(c => `<option value="${c.id}" ${c.id === a.courierId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
      </select>`;

    const titleLine = a.clientName ? escapeHtml(a.clientName) : escapeHtml(a.raw);
    const subAddressLine = a.clientName ? `<div class="addr-sub-addr">${escapeHtml(a.raw)}</div>` : '';
    const detailsLine = a.details ? `<div class="addr-sub-addr">📦 ${escapeHtml(a.details)}</div>` : '';
    const phoneLine = a.phone ? `<div class="addr-sub-addr">${escapeHtml(a.phone)}</div>` : '';
    const noteLine = a.customerNote ? `<div class="addr-sub-addr">💬 ${escapeHtml(a.customerNote)}</div>` : '';
    const paymentChip = (a.amount != null || a.paymentMethod)
      ? `<div class="addr-payment-chip ${a.paymentMethod === 'Ramburs' ? 'cod' : ''}">${a.amount != null ? a.amount.toFixed(2) + ' lei' : ''}${a.amount != null && a.paymentMethod ? ' · ' : ''}${escapeHtml(a.paymentMethod || '')}</div>`
      : '';

    item.innerHTML = `
      <span class="addr-badge">${idx + 1}</span>
      <div class="addr-text">
        <div class="addr-main">${titleLine}</div>
        ${subAddressLine}
        ${detailsLine}
        ${phoneLine}
        ${noteLine}
        ${paymentChip}
        ${statusHtml}
        <div class="addr-action-row">
          <button class="addr-action-link" data-edit="${a.id}">✎ editează</button>
          <span class="addr-action-sep">·</span>
          <span class="addr-action-label">realoca:</span>
          ${courierSelect}
          ${a.manuallyAssigned ? '<span class="addr-lock-badge" title="Alocare manuală — nu va fi schimbată de repartizarea automată">🔒</span>' : ''}
        </div>
      </div>
      <button class="addr-remove" data-id="${a.id}" title="Șterge">×</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.addr-courier-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = parseInt(sel.dataset.id);
      const addr = state.addresses.find(a => a.id === id);
      if (!addr) return;
      const newCourierId = sel.value ? parseInt(sel.value) : null;
      const oldCourierId = addr.courierId;
      if (newCourierId === oldCourierId) return;
      addr.courierId = newCourierId;
      addr.manuallyAssigned = newCourierId != null; // unassigning (—) clears the manual lock too

      // pull this address out of any existing route (old courier), and append it to the
      // new courier's route order if that courier already has an active route
      [oldCourierId, newCourierId].forEach(cid => {
        if (cid == null) return;
        const route = state.routes[cid];
        if (!route) return;
        if (cid === oldCourierId){
          const i = route.order.indexOf(id);
          if (i !== -1) route.order.splice(i, 1);
        }
        if (cid === newCourierId && !route.order.includes(id)){
          route.order.push(id);
        }
        if (route.order.length){
          recalcRouteDistance(cid);
        } else {
          delete state.routes[cid];
        }
      });

      renderAddresses();
      renderCouriers();
      renderRouteSummary();
      redrawMap();
      showToast(newCourierId ? `Adresă alocată manual către ${state.couriers.find(c=>c.id===newCourierId)?.name}.` : 'Adresă scoasă din alocare.');
    });
  });

  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.edit);
      showEditAddressForm(id);
    });
  });

  list.querySelectorAll('.addr-locate-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.locate);
      focusAddressOnMap(id);
    });
  });

  list.querySelectorAll('.addr-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      state.addresses = state.addresses.filter(a => a.id !== id);
      // remove this address from any route it was part of, and recalc that route's distance
      Object.keys(state.routes).forEach(courierId => {
        const route = state.routes[courierId];
        const idx = route.order.indexOf(id);
        if (idx !== -1){
          route.order.splice(idx, 1);
          if (route.order.length){
            recalcRouteDistance(parseInt(courierId));
          } else {
            delete state.routes[courierId];
          }
        }
      });
      renderAddresses();
      renderCouriers();
      renderRouteSummary();
      maybeShowGeocodeButton();
      redrawMap();
    });
  });
}

// -------------------------------------------------------------------
// GEOCODING — Nominatim, with confidence scoring and query cascade
// -------------------------------------------------------------------
const geocodeCache = new Map();

// ---- Persistent verified-address database (localStorage) ----------
// Once an address has been manually confirmed as correctly located (dragged on the map,
// or edited and re-confirmed), its exact text + coordinates are saved here. Future imports
// of the SAME exact address text skip Nominatim entirely and reuse the verified position —
// this is how repeat customers' addresses get more reliable over time.
const VERIFIED_ADDR_STORAGE_KEY = 'trasee-curieri:verified-addresses';

function loadVerifiedAddressDB(){
  try {
    const raw = localStorage.getItem(VERIFIED_ADDR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e){
    console.error('Could not read verified address DB', e);
    return {};
  }
}

function saveVerifiedAddressDB(db){
  try {
    localStorage.setItem(VERIFIED_ADDR_STORAGE_KEY, JSON.stringify(db));
  } catch (e){
    console.error('Could not save verified address DB', e);
  }
}

/**
 * Normalizes ONLY whitespace and case for the lookup key — exact text match otherwise,
 * as requested (no fuzzy matching). "Strada Garleni 11, București" and
 * "  strada garleni 11, bucuresti  " are treated as the same key, but any other
 * difference (missing word, different number, etc.) is a different address.
 */
function addressLookupKey(address){
  return String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getVerifiedAddress(address){
  const db = loadVerifiedAddressDB();
  return db[addressLookupKey(address)] || null;
}

function saveVerifiedAddress(address, lat, lng){
  const db = loadVerifiedAddressDB();
  db[addressLookupKey(address)] = { lat, lng, originalText: address, savedAt: new Date().toISOString() };
  saveVerifiedAddressDB(db);
  updateVerifiedDbCounter();
}

function removeVerifiedAddress(address){
  const db = loadVerifiedAddressDB();
  delete db[addressLookupKey(address)];
  saveVerifiedAddressDB(db);
}

function countVerifiedAddresses(){
  return Object.keys(loadVerifiedAddressDB()).length;
}

/**
 * Builds a list of query variants to try, from most to least specific.
 * Romanian street addresses are often abbreviated/incomplete (e.g. "Oltenitei 44"
 * instead of "Soseaua Oltenitei 44"), so common prefixes are tried explicitly.
 */
/**
 * Normalizes the road-type prefix on a street name as typed by a customer in a checkout form.
 * Handles common Romanian abbreviations (str, bd, sos, cal, alee, dr) and expands them to the
 * full word, which Nominatim matches far more reliably than abbreviations.
 * If no prefix is present at all, leaves the street name untouched (buildAddressVariants will
 * try adding "Strada"/"Șoseaua" as fallback variants during geocoding).
 */
const STREET_PREFIX_MAP = [
  { re: /^(str|strada)\.?\s+/i, full: 'Strada' },
  { re: /^(sos|șos|sosea|șoseaua?)\.?\s+/i, full: 'Șoseaua' },
  { re: /^(bd|blvd|bul|bulevardul?)\.?\s+/i, full: 'Bulevardul' },
  { re: /^(cal|calea)\.?\s+/i, full: 'Calea' },
  { re: /^(al|alee|aleea)\.?\s+/i, full: 'Aleea' },
  { re: /^(dr|drum|drumul)\.?\s+/i, full: 'Drumul' },
  { re: /^(int|intrarea)\.?\s+/i, full: 'Intrarea' },
  { re: /^(spl|splai|splaiul)\.?\s+/i, full: 'Splaiul' },
  { re: /^(pia[tț]a)\.?\s+/i, full: 'Piața' },
];

function normalizeStreetPrefix(street){
  const trimmed = street.trim();
  for (const { re, full } of STREET_PREFIX_MAP){
    if (re.test(trimmed)){
      return trimmed.replace(re, `${full} `);
    }
  }
  return trimmed; // no recognized prefix — left as-is, geocoding cascade will try adding one
}

/**
 * WooCommerce shipping forms in Bucharest often capture only "Sector N" as the city,
 * without "București". Nominatim needs the city name to resolve the sector reliably,
 * so "Sector 4" becomes "Sector 4, București" while other cities are left untouched.
 */
function normalizeCityForGeocoding(city){
  const trimmed = city.trim();
  if (/^sector\s*\d/i.test(trimmed) && !/bucure[sș]ti/i.test(trimmed)){
    return `${trimmed}, București`;
  }
  return trimmed;
}

function buildAddressVariants(address){
  const variants = [address];
  const ROAD_PREFIXES = ['Șoseaua', 'Strada', 'Bulevardul', 'Calea', 'Aleea', 'Drumul'];

  // if address has no known road-type prefix on its street segment, try adding common ones
  const hasPrefix = ROAD_PREFIXES.some(p => address.toLowerCase().includes(p.toLowerCase()));
  if (!hasPrefix){
    // format is "Stradă Nr, Oraș[, România]" — the street+number segment is always first
    const segments = address.split(',').map(s => s.trim());
    if (segments[0]){
      ROAD_PREFIXES.slice(0, 2).forEach(prefix => {
        const modified = [...segments];
        modified[0] = `${prefix} ${modified[0]}`;
        variants.push(modified.join(', '));
      });
    }
  }

  // fallback: drop the house number entirely (street+city only) — less precise but better than nothing
  const withoutNumber = address.replace(/,?\s*\b\d+[A-Za-z]?\b\s*(,|$)/, '$1').replace(/,\s*,/g, ',').trim();
  if (withoutNumber && withoutNumber !== address) variants.push(withoutNumber);

  return variants;
}

/**
 * Scores a Nominatim result's specificity based on its returned "type"/"class".
 * Returns 'high' (house-level), 'medium' (street-level), or 'low' (area/city-level only).
 */
function scoreResultConfidence(result){
  const type = result.type || '';
  if (result.address && result.address.house_number) return 'high';
  if (result.class === 'building' || type === 'house') return 'high';
  if (type === 'road' || type === 'street' || result.class === 'highway') return 'medium';
  return 'low';
}

// Service area: Bucharest + Ilfov county + ~25-30km margin around it (covers nearby
// localities like Snagov, Buftea, Periș, Ștefăneștii de Jos, etc.). Any geocoding result
// landing outside this box is treated as wrong/out-of-country and rejected outright,
// since deliveries are exclusively within this region.
const SERVICE_AREA_BOUNDS = { minLat: 43.93, maxLat: 44.93, minLng: 25.40, maxLng: 26.80 };

function isWithinServiceArea(lat, lng){
  return lat >= SERVICE_AREA_BOUNDS.minLat && lat <= SERVICE_AREA_BOUNDS.maxLat &&
         lng >= SERVICE_AREA_BOUNDS.minLng && lng <= SERVICE_AREA_BOUNDS.maxLng;
}

async function geocodeOne(address, allowOutOfArea = false){
  const cacheKey = allowOutOfArea ? `${address}__allowOOA` : address;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  // 1. Check the persistent verified-address database first — exact text match only.
  //    Skips Nominatim entirely for addresses we've already confirmed correct before.
  const verified = getVerifiedAddress(address);
  if (verified){
    const result = { lat: verified.lat, lng: verified.lng, confidence: 'verified', matchedQuery: address, displayName: '' };
    geocodeCache.set(cacheKey, result);
    return result;
  }

  const variants = buildAddressVariants(address);
  let bestResult = null;
  let bestOutOfAreaResult = null;
  let sawOutOfAreaResult = false;

  for (const variant of variants){
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=ro&q=${encodeURIComponent(variant)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'ro' } });
      const data = await res.json();
      if (data && data.length){
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        const confidence = scoreResultConfidence(data[0]);

        if (!isWithinServiceArea(lat, lng)){
          // Outside Bucharest/Ilfov+margin — rejected by default, but if the user explicitly
          // allowed out-of-area for this address, keep the best such result as a fallback
          // (still prefer continuing the cascade in case a later variant lands in-area).
          sawOutOfAreaResult = true;
          if (allowOutOfArea && (!bestOutOfAreaResult || confidence === 'high')){
            bestOutOfAreaResult = { lat, lng, confidence, matchedQuery: variant, displayName: data[0].display_name || '' };
          }
          continue;
        }

        const result = {
          lat, lng,
          confidence,
          matchedQuery: variant,
          displayName: data[0].display_name || ''
        };
        if (confidence === 'high'){
          geocodeCache.set(cacheKey, result);
          return result;
        }
        if (!bestResult) bestResult = result; // keep first medium/low as fallback, but keep trying for better
      }
    } catch (e){
      console.error('Geocode error', e);
    }
    if (variant !== variants[variants.length - 1]) await sleep(1000); // respect Nominatim rate limit between cascade attempts
  }

  if (!bestResult && allowOutOfArea && bestOutOfAreaResult){
    geocodeCache.set(cacheKey, bestOutOfAreaResult);
    return bestOutOfAreaResult;
  }

  if (!bestResult && sawOutOfAreaResult){
    // every variant resolved to somewhere outside the service area — flag distinctly so the
    // UI can show a clear "out of area" error instead of a generic "not found"
    geocodeCache.set(cacheKey, { outOfArea: true });
    return { outOfArea: true };
  }

  geocodeCache.set(cacheKey, bestResult);
  return bestResult;
}

async function geocodeAllPending(){
  const section = document.getElementById('geocodeSection');
  const statusRow = document.getElementById('geocodeStatus');
  const btn = document.getElementById('geocodeBtn');
  const pending = state.addresses.filter(a => a.status === 'pending');
  if (!pending.length) return;

  btn.style.display = 'none';
  statusRow.style.display = 'flex';

  let done = 0;
  let lowConfidenceCount = 0;
  let outOfAreaCount = 0;
  for (const a of pending){
    statusRow.querySelector('span:last-child').textContent = `Se localizează ${done + 1}/${pending.length}…`;
    const result = await geocodeOne(a.raw, a.allowOutOfArea);
    if (result && result.outOfArea){
      a.status = 'error';
      a.confidence = null;
      a.outOfArea = true;
      outOfAreaCount++;
    } else if (result){
      a.lat = result.lat;
      a.lng = result.lng;
      a.status = 'ok';
      a.confidence = result.confidence;
      a.outOfArea = !isWithinServiceArea(result.lat, result.lng); // true even when allowed, for visual flagging
      if (result.confidence !== 'high' && result.confidence !== 'verified') lowConfidenceCount++;
      if (result.confidence === 'high' && !a.outOfArea){
        saveVerifiedAddress(a.raw, result.lat, result.lng);
      }
    } else {
      a.status = 'error';
      a.confidence = null;
      a.outOfArea = false;
    }
    done++;
    renderAddresses();
    redrawMap();
    // Nominatim usage policy: max ~1 request/sec
    await sleep(1000);
  }

  statusRow.style.display = 'none';
  const errCount = state.addresses.filter(a => a.status === 'error').length;
  if (outOfAreaCount > 0){
    showToast(`${outOfAreaCount} adrese localizate în afara zonei de livrare (București/Ilfov) — corectează-le manual.`, true);
  } else if (errCount > 0){
    showToast(`${done} adrese procesate, ${errCount} neidentificate.`, true);
  } else if (lowConfidenceCount > 0){
    showToast(`${done} adrese localizate, ${lowConfidenceCount} cu precizie aproximativă — verifică-le pe hartă.`, true);
  } else {
    showToast(`${done} adrese localizate cu precizie ridicată.`);
  }
  maybeShowGeocodeButton();
  fitMapToAll();
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// -------------------------------------------------------------------
// AUTO-ASSIGNMENT (clustering) + ROUTE OPTIMIZATION (OSRM)
// -------------------------------------------------------------------
function initRoutePanel(){
  document.getElementById('autoAssignBtn').addEventListener('click', runAutoAssignAndRoute);
}

async function runAutoAssignAndRoute(){
  const geocodedAddrs = state.addresses.filter(a => a.status === 'ok');
  if (!geocodedAddrs.length){
    showToast('Nu există adrese localizate. Importă și geocodează mai întâi.', true);
    return;
  }

  // make sure every courier's start/end point reflects what's currently typed in the input,
  // even if the user never blurred the field (e.g. typed the address then clicked "Repartizează automat")
  await ensureAllCourierPointsGeocoded();

  const validCouriers = state.couriers.filter(c => c.start.status === 'ok');
  const invalidCouriers = state.couriers.filter(c => c.start.status !== 'ok');

  if (!validCouriers.length){
    showToast('Niciun curier nu are un punct de plecare valid. Completează adresa și încearcă din nou.', true);
    return;
  }
  if (invalidCouriers.length){
    const names = invalidCouriers.map(c => c.name).join(', ');
    showToast(`${names} ${invalidCouriers.length === 1 ? 'nu are' : 'nu au'} punct de plecare valid — exclus din repartizare.`, true);
  }

  showToast('Se repartizează adresele…');

  // 1. Assign each address to nearest courier start point (simple geographic clustering),
  //    then balance so no courier is overloaded relative to others.
  assignAddressesToNearestCourier(geocodedAddrs, validCouriers);

  renderAddresses();
  renderCouriers();

  // 2. For each courier, compute optimized order via OSRM
  for (const courier of validCouriers){
    const assigned = state.addresses.filter(a => a.courierId === courier.id && a.status === 'ok');
    if (!assigned.length){
      delete state.routes[courier.id];
      continue;
    }
    await computeOptimizedRoute(courier, assigned);
  }

  // 3. Refine for finish-time balance: if the gap between the longest and shortest route
  //    exceeds the allowed buffer, move addresses from the busiest courier to the lightest
  //    one and recompute, until everyone's total time is within the buffer (or nothing more
  //    can be moved without breaking the count-balance guarantee from step 1).
  await balanceRoutesByTime(validCouriers);

  renderCouriers();
  renderRouteSummary();
  redrawMap();
  updateMapTopBar();
  document.getElementById('exportBtn').disabled = Object.keys(state.routes).length === 0;
  showToast('Trasee generate.');
  switchToTab('panel-trasee');
}

const TIME_BALANCE_BUFFER_MIN = 120; // up to 2h difference in total route time is acceptable

/**
 * Moves addresses from the courier with the longest total route time to the one with the
 * shortest, recomputing both routes each time, until the gap is within the buffer or no
 * further beneficial move exists. Respects the count-balance guarantee from step 1 by
 * refusing to drop a courier below COUNT_BUFFER-worth of addresses relative to the rest.
 */
async function balanceRoutesByTime(couriers){
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++){
    const withRoutes = couriers
      .map(c => ({ courier: c, route: state.routes[c.id] }))
      .filter(x => x.route);
    if (withRoutes.length < 2) return;

    const longest = withRoutes.reduce((a,b) => b.route.totalMin > a.route.totalMin ? b : a);
    const shortest = withRoutes.reduce((a,b) => b.route.totalMin < a.route.totalMin ? b : a);
    const gap = longest.route.totalMin - shortest.route.totalMin;
    if (gap <= TIME_BALANCE_BUFFER_MIN || longest.courier.id === shortest.courier.id) return;

    // don't let the longest courier drop below what count-balance requires
    const totalAddrs = state.addresses.filter(a => a.status === 'ok').length;
    const minAllowed = Math.max(1, Math.floor(totalAddrs / couriers.length - COUNT_BUFFER / 2));
    const longestAddrs = state.addresses.filter(a => a.courierId === longest.courier.id && a.status === 'ok');
    if (longestAddrs.length <= minAllowed) return;

    // move whichever of the longest courier's addresses is closest to the shortest
    // courier's start point — minimizes the detour cost of the move
    let moveAddr = null, bestDist = Infinity;
    longestAddrs.forEach(a => {
      const d = haversine(a.lat, a.lng, shortest.courier.start.lat, shortest.courier.start.lng);
      if (d < bestDist){ bestDist = d; moveAddr = a; }
    });
    if (!moveAddr) return;

    moveAddr.courierId = shortest.courier.id;
    moveAddr.manuallyAssigned = false;

    const longestRemaining = state.addresses.filter(a => a.courierId === longest.courier.id && a.status === 'ok');
    const shortestNew = state.addresses.filter(a => a.courierId === shortest.courier.id && a.status === 'ok');
    if (longestRemaining.length){
      await computeOptimizedRoute(longest.courier, longestRemaining);
    } else {
      delete state.routes[longest.courier.id];
    }
    await computeOptimizedRoute(shortest.courier, shortestNew);
  }
}

/**
 * Geocodes any courier start/end point that has text typed in but hasn't been confirmed
 * yet (status still 'pending'). This covers the case where a courier was just added/edited
 * and the user clicked straight to "Repartizează automat" without tabbing out of the field.
 * Reads directly from the DOM inputs first, since unconfirmed edits (no blur yet) haven't
 * been written back to state.
 */
async function ensureAllCourierPointsGeocoded(){
  document.querySelectorAll('.start-input').forEach(input => {
    const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
    if (courier && input.value.trim() !== courier.start.address){
      courier.start.address = input.value.trim();
      courier.start.status = 'pending';
      courier.start.lat = null;
      courier.start.lng = null;
    }
  });
  document.querySelectorAll('.end-input').forEach(input => {
    const courier = state.couriers.find(c => c.id === parseInt(input.dataset.courier));
    if (courier && input.value.trim() !== courier.end.address){
      courier.end.address = input.value.trim();
      courier.end.status = 'pending';
      courier.end.lat = null;
      courier.end.lng = null;
    }
  });

  for (const courier of state.couriers){
    for (const pointKey of ['start', 'end']){
      const point = courier[pointKey];
      if (point.address && point.status === 'pending'){
        const result = await geocodeOne(point.address);
        if (result && result.outOfArea){
          point.status = 'error';
        } else if (result){
          point.lat = result.lat;
          point.lng = result.lng;
          point.status = 'ok';
        } else {
          point.status = 'error';
        }
      }
    }
  }
  renderCouriers();
}

/**
 * Two-phase address assignment:
 * 1. Geographic + count balance — assigns by proximity first, then forcibly rebalances
 *    so no courier ends up with zero (or far too few) addresses just because their start
 *    point happens to be geographically distant from the cluster. Balance target allows a
 *    buffer of up to COUNT_BUFFER addresses between the busiest and lightest courier.
 * 2. Time balance — handled separately in runAutoAssignAndRoute, after routes are computed,
 *    since it requires real driving-time data from OSRM.
 */
const COUNT_BUFFER = 6; // addresses of slack allowed between the busiest and lightest courier

/**
 * Groups addresses into N geographically compact clusters using a capacity-constrained
 * k-means-style algorithm. Each cluster is constrained to [minSize, maxSize] addresses,
 * so the result respects the count-balance requirement while keeping each group spatially
 * coherent — this is what prevents a single courier's route from zig-zagging across the
 * whole service area just because individual addresses happened to be "closest" to their
 * start point in isolation.
 */
function clusterAddressesGeographically(addrs, numClusters, minSize, maxSize){
  if (!addrs.length || numClusters <= 0) return [];
  if (numClusters === 1) return [addrs.slice()];

  // Seed centroids spread out via a k-means++-style farthest-point heuristic
  const centroids = [{ lat: addrs[0].lat, lng: addrs[0].lng }];
  while (centroids.length < numClusters){
    let farthest = null, farthestDist = -1;
    addrs.forEach(a => {
      const minDistToCentroids = Math.min(...centroids.map(c => haversine(a.lat, a.lng, c.lat, c.lng)));
      if (minDistToCentroids > farthestDist){ farthestDist = minDistToCentroids; farthest = a; }
    });
    centroids.push({ lat: farthest.lat, lng: farthest.lng });
  }

  let assignment = new Array(addrs.length).fill(0);
  for (let iter = 0; iter < 15; iter++){
    // Capacity-aware assignment: addresses with the strongest preference for their best
    // cluster (vs. their second choice) get assigned first, filling each cluster up to
    // maxSize before it stops accepting new members.
    const clusterCounts = new Array(numClusters).fill(0);
    const prefs = addrs.map((a, i) => {
      const dists = centroids.map(c => haversine(a.lat, a.lng, c.lat, c.lng));
      const sorted = dists.map((d, ci) => [d, ci]).sort((x,y) => x[0]-y[0]);
      return { idx: i, sorted, gap: sorted.length > 1 ? sorted[1][0] - sorted[0][0] : 0 };
    });
    prefs.sort((a,b) => b.gap - a.gap);

    const newAssignment = new Array(addrs.length).fill(-1);
    prefs.forEach(p => {
      for (const [, clusterIdx] of p.sorted){
        if (clusterCounts[clusterIdx] < maxSize){
          newAssignment[p.idx] = clusterIdx;
          clusterCounts[clusterIdx]++;
          break;
        }
      }
      if (newAssignment[p.idx] === -1){
        // every cluster at capacity — extremely rare (only if maxSize*numClusters < addrs.length)
        let minIdx = 0;
        for (let c = 1; c < numClusters; c++) if (clusterCounts[c] < clusterCounts[minIdx]) minIdx = c;
        newAssignment[p.idx] = minIdx;
        clusterCounts[minIdx]++;
      }
    });
    assignment = newAssignment;

    for (let c = 0; c < numClusters; c++){
      const members = addrs.filter((_, i) => assignment[i] === c);
      if (members.length){
        centroids[c] = {
          lat: members.reduce((s,a) => s+a.lat, 0) / members.length,
          lng: members.reduce((s,a) => s+a.lng, 0) / members.length
        };
      }
    }
  }

  const clusters = Array.from({length: numClusters}, () => []);
  addrs.forEach((a, i) => clusters[assignment[i]].push(a));
  return clusters;
}

function assignAddressesToNearestCourier(addrs, couriers){
  const locked = addrs.filter(a => a.manuallyAssigned && a.courierId != null && couriers.some(c => c.id === a.courierId));
  const free = addrs.filter(a => !locked.includes(a));

  free.forEach(a => a.courierId = null);
  if (!free.length) return;

  const target = addrs.length / couriers.length;
  const minAllowed = Math.max(1, Math.floor(target - COUNT_BUFFER / 2));
  const maxAllowed = Math.ceil(target + COUNT_BUFFER / 2);

  // 1. Split the free addresses into N geographically compact clusters (N = number of
  //    couriers), each within the allowed size range.
  const clusters = clusterAddressesGeographically(free, couriers.length, minAllowed, maxAllowed);

  // 2. Assign each compact cluster — as a whole — to the courier whose start point is
  //    closest to that cluster's centroid. This is a one-to-one assignment problem solved
  //    greedily: repeatedly pick the (cluster, courier) pair with the smallest distance,
  //    removing both from further consideration.
  const clusterCentroids = clusters.map(cl => ({
    lat: cl.reduce((s,a) => s+a.lat, 0) / cl.length,
    lng: cl.reduce((s,a) => s+a.lng, 0) / cl.length
  }));

  const remainingClusterIdx = clusters.map((_, i) => i);
  const remainingCouriers = couriers.slice();
  while (remainingClusterIdx.length && remainingCouriers.length){
    let bestPair = null, bestDist = Infinity;
    remainingClusterIdx.forEach(ci => {
      remainingCouriers.forEach(c => {
        const d = haversine(clusterCentroids[ci].lat, clusterCentroids[ci].lng, c.start.lat, c.start.lng);
        if (d < bestDist){ bestDist = d; bestPair = { ci, courier: c }; }
      });
    });
    clusters[bestPair.ci].forEach(a => { a.courierId = bestPair.courier.id; });
    remainingClusterIdx.splice(remainingClusterIdx.indexOf(bestPair.ci), 1);
    remainingCouriers.splice(remainingCouriers.indexOf(bestPair.courier), 1);
  }
}

function haversine(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Build coordinate list: start -> stops -> end, ask OSRM /trip for optimized order of stops
const STOP_BUFFER_MIN = 10; // fixed handoff/buffer time added per delivery stop

async function computeOptimizedRoute(courier, stops){
  const end = courier.sameAsStart || courier.end.status !== 'ok' ? courier.start : courier.end;

  // OSRM trip service optimizes order but for fixed start/end we use 'roundtrip=false' with source/destination fixed
  const coords = [courier.start, ...stops.map(s => ({lat:s.lat,lng:s.lng})), end];
  const coordStr = coords.map(c => `${c.lng},${c.lat}`).join(';');

  try {
    const url = `https://router.project-osrm.org/trip/v1/driving/${coordStr}?source=first&destination=last&roundtrip=false&overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.code === 'Ok' && data.trips && data.trips.length){
      const trip = data.trips[0];
      const waypoints = data.waypoints;
      // waypoints array maps input index -> {waypoint_index (order), trips_index}
      // indices 0 = start, last = end, in-between = stops in original order
      const stopOrder = [];
      for (let i = 1; i <= stops.length; i++){
        stopOrder.push({ stop: stops[i-1], order: waypoints[i].waypoint_index });
      }
      stopOrder.sort((a,b) => a.order - b.order);
      const orderedIds = stopOrder.map(s => s.stop.id);

      // trip.legs[i] is the driving leg FROM visit-position i TO visit-position i+1,
      // in optimized order (0 = start->firstStop, ..., last = lastStop->end)
      const legDurationsMin = (trip.legs || []).map(leg => leg.duration / 60);

      state.routes[courier.id] = {
        order: orderedIds,
        totalKm: trip.distance / 1000,
        totalMin: trip.duration / 60,
        geometry: trip.geometry,
        legDurationsMin // array: driving time in minutes for each leg, start->stop1->stop2->...->end
      };
      computeDeliveryWindows(courier, state.routes[courier.id]);
    } else {
      // fallback: nearest-neighbor heuristic if OSRM trip fails
      fallbackRoute(courier, stops, end);
    }
  } catch (e){
    console.error('OSRM error', e);
    fallbackRoute(courier, stops, end);
  }
}

function fallbackRoute(courier, stops, end){
  // simple nearest-neighbor ordering, straight-line distances
  const remaining = [...stops];
  const order = [];
  const legDurationsMin = [];
  let current = { lat: courier.start.lat, lng: courier.start.lng };
  let totalKm = 0;
  const AVG_SPEED_KMH = 35; // rough urban average for the straight-line fallback estimate
  while (remaining.length){
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversine(current.lat, current.lng, s.lat, s.lng);
      if (d < bestDist){ bestDist = d; bestIdx = i; }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    order.push(next.id);
    totalKm += bestDist;
    legDurationsMin.push(bestDist / AVG_SPEED_KMH * 60);
    current = { lat: next.lat, lng: next.lng };
  }
  const lastLegKm = haversine(current.lat, current.lng, end.lat, end.lng);
  totalKm += lastLegKm;
  legDurationsMin.push(lastLegKm / AVG_SPEED_KMH * 60);

  state.routes[courier.id] = {
    order,
    totalKm,
    totalMin: totalKm / AVG_SPEED_KMH * 60,
    geometry: null,
    legDurationsMin
  };
  computeDeliveryWindows(courier, state.routes[courier.id]);
  showToast(`Traseu pentru ${courier.name}: estimare aproximativă (serviciul de rutare a fost indisponibil).`, true);
}

// -------------------------------------------------------------------
// DELIVERY TIME WINDOWS
// -------------------------------------------------------------------

function normalizeTime(str){
  const match = String(str || '').trim().match(/^(\d{1,2})[:.h]?(\d{2})?$/);
  if (!match) return '10:00';
  let h = parseInt(match[1]);
  let m = match[2] ? parseInt(match[2]) : 0;
  h = Math.max(0, Math.min(23, h));
  m = Math.max(0, Math.min(59, m));
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;
}

function parseTimeToMinutes(str){
  const normalized = normalizeTime(str);
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

function formatMinutesToTime(totalMin){
  let m = Math.round(totalMin) % (24 * 60);
  if (m < 0) m += 24 * 60;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h.toString().padStart(2,'0')}:${mm.toString().padStart(2,'0')}`;
}

/**
 * Computes a fixed 2-hour delivery window for each stop in the route.
 * Logic: estimated arrival time = departure + cumulative driving time + (10min buffer × stops already made),
 * then rounded DOWN to the nearest hour, giving a [rounded, rounded+2h] window.
 * e.g. arrival 10:00 -> 10:00–12:00 · arrival 11:30 -> 11:00–13:00 · arrival 11:59 -> 11:00–13:00
 */
function computeDeliveryWindows(courier, route){
  const departureMin = parseTimeToMinutes(courier.departureTime || '10:00');
  const legs = route.legDurationsMin || [];
  const windows = {};

  let cumulativeMin = departureMin;
  route.order.forEach((addrId, idx) => {
    cumulativeMin += (legs[idx] || 0); // driving time to reach this stop
    const arrivalMin = cumulativeMin;
    const roundedHour = Math.floor(arrivalMin / 60) * 60;
    windows[addrId] = {
      arrivalMin,
      windowStart: formatMinutesToTime(roundedHour),
      windowEnd: formatMinutesToTime(roundedHour + 120),
      afterLimit: courier.endTimeLimit ? arrivalMin > parseTimeToMinutes(courier.endTimeLimit) : false
    };
    cumulativeMin += STOP_BUFFER_MIN; // handoff buffer before heading to the next stop
  });

  route.windows = windows;
}

function formatMinutes(min){
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h${m.toString().padStart(2,'0')}` : `${m}min`;
}

// -------------------------------------------------------------------
// ROUTE SUMMARY (sidebar tab) — drag & drop reorder, manual reassign
// -------------------------------------------------------------------
function renderRouteSummary(){
  const container = document.getElementById('routeSummary');
  const hasAny = Object.keys(state.routes).length > 0;

  if (!hasAny){
    container.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">→</div>
        <div class="es-title">Niciun traseu generat</div>
        <div class="es-sub">Adaugă curieri și adrese, apoi repartizează</div>
      </div>`;
    state.routeSelection = new Set();
    return;
  }

  if (!state.routeSelection) state.routeSelection = new Set();
  // drop any selected ids that no longer exist in a route (e.g. after a removal)
  const allRoutedIds = new Set(Object.values(state.routes).flatMap(r => r.order));
  state.routeSelection.forEach(id => { if (!allRoutedIds.has(id)) state.routeSelection.delete(id); });

  container.innerHTML = '';

  renderBulkMoveBar(container);

  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;

    const assignedAddrs = route.order.map(id => state.addresses.find(a => a.id === id)).filter(Boolean);
    const totalToCollect = assignedAddrs.reduce((sum, a) => sum + (a.amount || 0), 0);
    const cashToCollect = assignedAddrs
      .filter(a => a.paymentMethod === 'Ramburs')
      .reduce((sum, a) => sum + (a.amount || 0), 0);

    const block = document.createElement('div');
    block.style.marginBottom = '18px';
    block.innerHTML = `
      <div style="display:flex; align-items:center; gap:7px; margin-bottom:4px;">
        <span class="courier-dot" style="background:${c.color}"></span>
        <span style="font-weight:600; font-size:13px;">${escapeHtml(c.name)}</span>
        <span style="margin-left:auto; font-family:'JetBrains Mono',monospace; font-size:10.5px; color:var(--ink-soft);">
          ${route.totalKm.toFixed(1)} km · ${formatMinutes(route.totalMin)}
        </span>
      </div>
      ${totalToCollect > 0 ? `
        <div style="font-family:'JetBrains Mono',monospace; font-size:10.5px; color:var(--ink-soft); margin-bottom:8px; padding-left:18px;">
          de încasat total: <strong style="color:var(--ink);">${totalToCollect.toFixed(2)} lei</strong>
          ${cashToCollect > 0 ? ` · ramburs: <strong style="color:#B5400E;">${cashToCollect.toFixed(2)} lei</strong>` : ''}
        </div>` : `<div style="margin-bottom:8px;"></div>`}
      <div class="route-stops" data-courier="${c.id}"></div>
    `;
    container.appendChild(block);

    const stopsDiv = block.querySelector('.route-stops');
    route.order.forEach((addrId, idx) => {
      const addr = state.addresses.find(a => a.id === addrId);
      if (!addr) return;
      const stopEl = document.createElement('div');
      stopEl.className = 'route-stop-item';
      stopEl.dataset.id = addr.id;
      stopEl.dataset.courier = c.id;

      const titleLine = addr.clientName ? escapeHtml(addr.clientName) : escapeHtml(addr.raw);
      const subAddressLine = addr.clientName ? `<div class="addr-sub-addr">${escapeHtml(addr.raw)}</div>` : '';
      const detailsLine = addr.details ? `<div class="addr-sub-addr">📦 ${escapeHtml(addr.details)}</div>` : '';
      const phoneLine = addr.phone ? `<div class="addr-sub-addr">${escapeHtml(addr.phone)}</div>` : '';
      const paymentChip = (addr.amount != null || addr.paymentMethod)
        ? `<div class="addr-payment-chip ${addr.paymentMethod === 'Ramburs' ? 'cod' : ''}">${addr.amount != null ? addr.amount.toFixed(2) + ' lei' : ''}${addr.amount != null && addr.paymentMethod ? ' · ' : ''}${escapeHtml(addr.paymentMethod || '')}</div>`
        : '';
      const win = route.windows ? route.windows[addr.id] : null;
      const windowChip = win
        ? `<div class="addr-window-chip${win.afterLimit ? ' warn' : ''}">⏱ ${win.windowStart}–${win.windowEnd}${win.afterLimit ? ' · după ora limită' : ''}</div>`
        : '';
      const isFirst = idx === 0;
      const isLast = idx === route.order.length - 1;
      const isChecked = state.routeSelection.has(addr.id);

      stopEl.innerHTML = `
        <div class="rs-drag-handle" draggable="true" title="Trage pentru a reordona">⠿</div>
        <input type="checkbox" class="rs-checkbox" data-select="${addr.id}" ${isChecked ? 'checked' : ''}>
        <span class="addr-badge" style="background:${c.color}">${idx + 1}</span>
        <div class="addr-text">
          <div class="addr-main">${titleLine}</div>
          ${windowChip}
          ${subAddressLine}
          ${detailsLine}
          ${phoneLine}
          ${paymentChip}
          <div class="rs-row-actions">
            <select class="rs-courier-select" data-id="${addr.id}">
              ${state.couriers.map(co => `<option value="${co.id}" ${co.id === c.id ? 'selected' : ''}>${escapeHtml(co.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="rs-order-buttons">
          <button class="rs-order-btn" data-move-up="${addr.id}" ${isFirst ? 'disabled' : ''} title="Mută mai sus">▲</button>
          <button class="rs-order-btn" data-move-down="${addr.id}" ${isLast ? 'disabled' : ''} title="Mută mai jos">▼</button>
        </div>
      `;
      stopsDiv.appendChild(stopEl);
    });

    enableDragReorder(stopsDiv, c.id);
  });

  wireRouteStopControls(container);
}

function renderBulkMoveBar(container){
  const bar = document.createElement('div');
  bar.id = 'bulkMoveBar';
  bar.className = 'bulk-move-bar';
  bar.style.display = state.routeSelection.size ? 'flex' : 'none';
  bar.innerHTML = `
    <span class="bulk-move-count">${state.routeSelection.size} selectate</span>
    <select id="bulkMoveTarget" class="rs-courier-select" style="flex:1;">
      ${state.couriers.map(co => `<option value="${co.id}">${escapeHtml(co.name)}</option>`).join('')}
    </select>
    <button class="btn btn-primary btn-sm" id="bulkMoveBtn">Mută</button>
    <button class="btn-icon" id="bulkMoveClearBtn" title="Anulează selecția">×</button>
  `;
  container.appendChild(bar);
}

function wireRouteStopControls(container){
  // selection checkboxes
  container.querySelectorAll('[data-select]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.select);
      if (cb.checked) state.routeSelection.add(id);
      else state.routeSelection.delete(id);
      renderRouteSummary();
      redrawMap();
    });
  });

  // up/down reorder buttons
  container.querySelectorAll('[data-move-up]').forEach(btn => {
    btn.addEventListener('click', () => moveStopByOffset(parseInt(btn.dataset.moveUp), -1));
  });
  container.querySelectorAll('[data-move-down]').forEach(btn => {
    btn.addEventListener('click', () => moveStopByOffset(parseInt(btn.dataset.moveDown), 1));
  });

  // per-row courier reassignment
  container.querySelectorAll('.rs-courier-select').forEach(sel => {
    if (sel.id === 'bulkMoveTarget') return; // handled separately
    sel.addEventListener('change', () => {
      const addrId = parseInt(sel.dataset.id);
      const newCourierId = parseInt(sel.value);
      moveAddressToCourier(addrId, newCourierId);
    });
  });

  // bulk move bar
  const bulkBtn = document.getElementById('bulkMoveBtn');
  if (bulkBtn){
    bulkBtn.addEventListener('click', () => {
      const targetId = parseInt(document.getElementById('bulkMoveTarget').value);
      const ids = Array.from(state.routeSelection);
      ids.forEach(id => moveAddressToCourier(id, targetId, { skipRender: true }));
      state.routeSelection.clear();
      renderAddresses();
      renderCouriers();
      renderRouteSummary();
      redrawMap();
      showToast(`${ids.length} ${ids.length === 1 ? 'adresă mutată' : 'adrese mutate'}.`);
    });
  }
  const clearBtn = document.getElementById('bulkMoveClearBtn');
  if (clearBtn){
    clearBtn.addEventListener('click', () => {
      state.routeSelection.clear();
      renderRouteSummary();
      redrawMap();
    });
  }
}

/**
 * Moves one address from its current courier's route to another courier's route,
 * appending it at the end of the destination and recomputing distances for both.
 * Mirrors the reassignment logic already used by the dropdown in the Adrese tab.
 */
function moveAddressToCourier(addrId, newCourierId, opts = {}){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;
  const oldCourierId = addr.courierId;
  if (newCourierId === oldCourierId) return;

  addr.courierId = newCourierId;
  addr.manuallyAssigned = true;

  [oldCourierId, newCourierId].forEach(cid => {
    if (cid == null) return;
    let route = state.routes[cid];
    if (!route){
      if (cid !== newCourierId) return; // nothing to clean up on the old side if it never had a route
      // destination courier has no active route yet — create a minimal one so the address
      // doesn't silently disappear from the Trasee tab after the move
      route = { order: [], totalKm: 0, totalMin: 0, geometry: null, legDurationsMin: [] };
      state.routes[cid] = route;
    }
    if (cid === oldCourierId){
      const i = route.order.indexOf(addrId);
      if (i !== -1) route.order.splice(i, 1);
    }
    if (cid === newCourierId && !route.order.includes(addrId)){
      route.order.push(addrId);
    }
    if (route.order.length){
      recalcRouteDistance(cid);
    } else {
      delete state.routes[cid];
    }
  });

  if (!opts.skipRender){
    renderAddresses();
    renderCouriers();
    renderRouteSummary();
    redrawMap();
    const targetCourier = state.couriers.find(c => c.id === newCourierId);
    showToast(`Adresă mutată la ${targetCourier ? targetCourier.name : 'curier'}.`);
  }
}

function moveStopByOffset(addrId, offset){
  const courierId = state.addresses.find(a => a.id === addrId)?.courierId;
  const route = state.routes[courierId];
  if (!route) return;
  const idx = route.order.indexOf(addrId);
  const newIdx = idx + offset;
  if (idx === -1 || newIdx < 0 || newIdx >= route.order.length) return;
  [route.order[idx], route.order[newIdx]] = [route.order[newIdx], route.order[idx]];
  recalcRouteDistance(courierId);
  renderRouteSummary();
  redrawMap();
}

function enableDragReorder(container, courierId){
  let draggedId = null;
  container.querySelectorAll('.route-stop-item').forEach(item => {
    const handle = item.querySelector('.rs-drag-handle');
    if (!handle) return;

    handle.addEventListener('dragstart', e => {
      draggedId = parseInt(item.dataset.id);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    handle.addEventListener('dragend', () => item.classList.remove('dragging'));

    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (parseInt(item.dataset.id) !== draggedId) item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const targetId = parseInt(item.dataset.id);
      if (draggedId === targetId) return;
      reorderStop(courierId, draggedId, targetId);
    });
  });
}

function reorderStop(courierId, draggedId, targetId){
  const route = state.routes[courierId];
  if (!route) return;
  const fromIdx = route.order.indexOf(draggedId);
  const toIdx = route.order.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  route.order.splice(fromIdx, 1);
  route.order.splice(toIdx, 0, draggedId);
  recalcRouteDistance(courierId);
  renderRouteSummary();
  redrawMap();
}

function recalcRouteDistance(courierId){
  // recompute straight-line distance as an approximation after manual reorder
  const courier = state.couriers.find(c => c.id === courierId);
  const route = state.routes[courierId];
  if (!courier || !route) return;
  const end = courier.sameAsStart || courier.end.status !== 'ok' ? courier.start : courier.end;
  const AVG_SPEED_KMH = 35;
  let total = 0;
  const legDurationsMin = [];
  let current = { lat: courier.start.lat, lng: courier.start.lng };
  route.order.forEach(id => {
    const addr = state.addresses.find(a => a.id === id);
    const legKm = haversine(current.lat, current.lng, addr.lat, addr.lng);
    total += legKm;
    legDurationsMin.push(legKm / AVG_SPEED_KMH * 60);
    current = { lat: addr.lat, lng: addr.lng };
  });
  const lastLegKm = haversine(current.lat, current.lng, end.lat, end.lng);
  total += lastLegKm;
  legDurationsMin.push(lastLegKm / AVG_SPEED_KMH * 60);

  route.totalKm = total;
  route.totalMin = total / AVG_SPEED_KMH * 60;
  route.geometry = null; // straight-line fallback until re-optimized
  route.legDurationsMin = legDurationsMin;
  computeDeliveryWindows(courier, route);
}

// -------------------------------------------------------------------
// MAP RENDERING
// -------------------------------------------------------------------
function buildStopPopup(stopNumber, courierName, addr, win){
  const title = stopNumber ? `Stop ${stopNumber} — ${escapeHtml(courierName)}` : escapeHtml(courierName);
  const nameLine = addr.clientName ? `<div class="sp-name">${escapeHtml(addr.clientName)}</div>` : '';
  const outOfAreaLine = addr.outOfArea ? `<div class="sp-window warn">⚠ în afara zonei București/Ilfov${addr.allowOutOfArea ? ' (permis manual)' : ''}</div>` : '';
  const windowLine = win
    ? `<div class="sp-window${win.afterLimit ? ' warn' : ''}">⏱ ${win.windowStart}–${win.windowEnd}${win.afterLimit ? ' · după ora limită' : ''}</div>`
    : '';
  const detailsLine = addr.details ? `<div class="sp-meta">📦 ${escapeHtml(addr.details)}</div>` : '';
  const phoneLine = addr.phone ? `<div class="sp-meta">📞 ${escapeHtml(addr.phone)}</div>` : '';
  const paymentLine = (addr.amount != null || addr.paymentMethod)
    ? `<div class="sp-payment">${addr.amount != null ? addr.amount.toFixed(2) + ' lei' : ''}${addr.amount != null && addr.paymentMethod ? ' · ' : ''}${escapeHtml(addr.paymentMethod || '')}</div>`
    : '';
  return `<div class="stop-popup">
    <div class="sp-title">${title}</div>
    ${nameLine}
    ${outOfAreaLine}
    ${windowLine}
    <div class="sp-meta">${escapeHtml(addr.raw)}</div>
    ${detailsLine}
    ${phoneLine}
    ${paymentLine}
  </div>`;
}

function makeDotIcon(color, addr){
  const isLowConfidence = !addr.manuallyAdjusted && addr.confidence && addr.confidence !== 'high' && addr.confidence !== 'verified';
  const ringColor = isLowConfidence ? 'var(--danger)' : '#fff';
  const ringWidth = isLowConfidence ? 3 : 2;
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:${ringWidth}px solid ${ringColor};box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>`,
    iconSize: [14,14],
    iconAnchor: [7,7]
  });
}

function onAddressMarkerDragged(addrId, newLatLng){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr) return;
  addr.lat = newLatLng.lat;
  addr.lng = newLatLng.lng;
  addr.manuallyAdjusted = true;
  addr.confidence = 'high'; // manual placement is by definition the most trustworthy
  addr.outOfArea = !isWithinServiceArea(newLatLng.lat, newLatLng.lng);

  // save to the persistent verified-address database for future imports of this exact
  // address text — but only if the corrected position is actually within the service area
  if (!addr.outOfArea && addr.raw){
    saveVerifiedAddress(addr.raw, newLatLng.lat, newLatLng.lng);
  }

  // any route containing this address now has a stale leg/geometry — recompute distances
  Object.keys(state.routes).forEach(courierId => {
    const route = state.routes[parseInt(courierId)];
    if (route && route.order.includes(addrId)){
      recalcRouteDistance(parseInt(courierId));
    }
  });

  renderAddresses();
  renderCouriers();
  renderRouteSummary();
  redrawMap();
  if (addr.outOfArea){
    showToast('Atenție: poziția trasă este în afara zonei București/Ilfov.', true);
  } else {
    showToast('Poziție actualizată manual și salvată în baza de adrese verificate.');
  }
}

function focusAddressOnMap(addrId){
  const addr = state.addresses.find(a => a.id === addrId);
  if (!addr || addr.lat == null) return;
  map.setView([addr.lat, addr.lng], 17, { animate: true });
  // small delay to let markers redraw/move before opening the popup
  setTimeout(() => {
    markersLayer.eachLayer(layer => {
      const ll = layer.getLatLng ? layer.getLatLng() : null;
      if (ll && Math.abs(ll.lat - addr.lat) < 1e-9 && Math.abs(ll.lng - addr.lng) < 1e-9){
        layer.openPopup();
      }
    });
  }, 350);
}

function redrawMap(){
  markersLayer.clearLayers();
  routeLinesLayer.clearLayers();

  const legend = document.getElementById('mapLegend');
  let legendHtml = '';
  const allPoints = [];

  state.couriers.forEach(c => {
    const route = state.routes[c.id];

    // start marker
    if (c.start.status === 'ok'){
      const m = L.circleMarker([c.start.lat, c.start.lng], {
        radius: 8, color: '#fff', weight: 2, fillColor: c.color, fillOpacity: 1
      }).addTo(markersLayer);
      m.bindPopup(`<div class="stop-popup"><div class="sp-title">${escapeHtml(c.name)} — start</div><div class="sp-meta">${escapeHtml(c.start.address)}</div></div>`);
      allPoints.push([c.start.lat, c.start.lng]);
    }

    // end marker (if different)
    if (!c.sameAsStart && c.end.status === 'ok'){
      const m = L.circleMarker([c.end.lat, c.end.lng], {
        radius: 8, color: c.color, weight: 2, fillColor: '#fff', fillOpacity: 1
      }).addTo(markersLayer);
      m.bindPopup(`<div class="stop-popup"><div class="sp-title">${escapeHtml(c.name)} — final</div><div class="sp-meta">${escapeHtml(c.end.address)}</div></div>`);
      allPoints.push([c.end.lat, c.end.lng]);
    }

    if (route){
      // numbered stop markers
      route.order.forEach((addrId, idx) => {
        const addr = state.addresses.find(a => a.id === addrId);
        if (!addr) return;
        const isLowConfidence = !addr.manuallyAdjusted && addr.confidence && addr.confidence !== 'high' && addr.confidence !== 'verified';
        const ringColor = isLowConfidence ? 'var(--danger)' : '#fff';
        const ringWidth = isLowConfidence ? 3 : 2;
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:${c.color};color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;border:${ringWidth}px solid ${ringColor};box-shadow:0 1px 4px rgba(0,0,0,0.25);">${idx+1}</div>`,
          iconSize: [22,22],
          iconAnchor: [11,11]
        });
        const m = L.marker([addr.lat, addr.lng], { icon, draggable: true }).addTo(markersLayer);
        const win = route.windows ? route.windows[addr.id] : null;
        m.bindPopup(buildStopPopup(idx+1, c.name, addr, win));
        m.on('dragend', e => onAddressMarkerDragged(addr.id, e.target.getLatLng()));
        allPoints.push([addr.lat, addr.lng]);
      });

      // route line
      if (route.geometry){
        const latlngs = route.geometry.coordinates.map(([lng,lat]) => [lat,lng]);
        L.polyline(latlngs, { color: c.color, weight: 3.5, opacity: 0.85 }).addTo(routeLinesLayer);
      } else {
        // straight-line fallback
        const end = c.sameAsStart || c.end.status !== 'ok' ? c.start : c.end;
        const pts = [[c.start.lat, c.start.lng]];
        route.order.forEach(id => {
          const addr = state.addresses.find(a => a.id === id);
          if (addr) pts.push([addr.lat, addr.lng]);
        });
        pts.push([end.lat, end.lng]);
        L.polyline(pts, { color: c.color, weight: 3, opacity: 0.6, dashArray: '6,6' }).addTo(routeLinesLayer);
      }

      legendHtml += `<div class="lg-row"><span class="lg-dot" style="background:${c.color}"></span><span class="lg-name">${escapeHtml(c.name)}</span><span class="lg-dist">${route.totalKm.toFixed(1)} km</span></div>`;
    } else {
      // un-routed geocoded addresses assigned to this courier
      state.addresses.filter(a => a.courierId === c.id && a.status === 'ok').forEach(addr => {
        const m = L.marker([addr.lat, addr.lng], { icon: makeDotIcon(c.color, addr), draggable: true }).addTo(markersLayer);
        m.bindPopup(buildStopPopup(null, c.name, addr));
        m.on('dragend', e => onAddressMarkerDragged(addr.id, e.target.getLatLng()));
        allPoints.push([addr.lat, addr.lng]);
      });
    }
  });

  // unassigned geocoded addresses
  state.addresses.filter(a => !a.courierId && a.status === 'ok').forEach(addr => {
    const m = L.marker([addr.lat, addr.lng], { icon: makeDotIcon('#999', addr), draggable: true }).addTo(markersLayer);
    m.bindPopup(buildStopPopup(null, 'Nerepartizat', addr));
    m.on('dragend', e => onAddressMarkerDragged(addr.id, e.target.getLatLng()));
    allPoints.push([addr.lat, addr.lng]);
  });

  if (legendHtml){
    legend.style.display = 'block';
    legend.innerHTML = legendHtml;
  } else {
    legend.style.display = 'none';
  }

  updateMapTopBar();
}

function fitMapToAll(){
  const pts = [];
  state.couriers.forEach(c => {
    if (c.start.status === 'ok') pts.push([c.start.lat, c.start.lng]);
    if (!c.sameAsStart && c.end.status === 'ok') pts.push([c.end.lat, c.end.lng]);
  });
  state.addresses.forEach(a => { if (a.status === 'ok') pts.push([a.lat, a.lng]); });
  if (pts.length){
    map.fitBounds(L.latLngBounds(pts), { padding: [40,40], maxZoom: 14 });
  }
}

// -------------------------------------------------------------------
// ACTION BAR — reset / export
// -------------------------------------------------------------------
function initActionBar(){
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Sigur vrei să resetezi tot? Se vor șterge curierii, adresele și traseele.')) return;
    state.couriers = [];
    state.addresses = [];
    state.routes = {};
    state.nextCourierId = 1;
    state.nextAddrId = 1;
    addCourier();
    renderAddresses();
    renderRouteSummary();
    redrawMap();
    document.getElementById('exportBtn').disabled = true;
    document.getElementById('geocodeSection').style.display = 'none';
    map.setView([45.9432, 24.9668], 7);
    switchToTab('panel-curieri');
  });

  document.getElementById('exportBtn').addEventListener('click', exportRoutesXlsx);
}

function splitClientName(fullName){
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  // last word = last name, everything before = first name (handles compound first names like "Constantin Dan")
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function exportRoutesXlsx(){
  const header = ['Curier', 'Interval Livrare', 'Nr. Comanda', 'First Name (Shipping)', 'Last Name (Shipping)', 'Phone (Billing)', 'Adresa', 'Detalii', 'Payment Method Title', 'Order Total Amount', 'Customer Note'];
  const rows = [header];
  let fallbackOrderNo = 1;

  state.couriers.forEach(c => {
    const route = state.routes[c.id];
    if (!route) return;
    route.order.forEach(id => {
      const addr = state.addresses.find(a => a.id === id);
      if (!addr) return;
      const { firstName, lastName } = splitClientName(addr.clientName);
      const win = route.windows ? route.windows[addr.id] : null;
      const interval = win ? `${win.windowStart} - ${win.windowEnd}` : '';
      // use the real WooCommerce order number when available; only fall back to a
      // sequential counter for addresses that have none (e.g. added manually)
      const orderNo = addr.orderNumber || fallbackOrderNo++;
      rows.push([
        c.name, interval, orderNo,
        firstName, lastName, addr.phone || '',
        addr.raw, addr.details || '',
        addr.paymentMethod || '', addr.amount != null ? addr.amount : '',
        addr.customerNote || ''
      ]);
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    {wch:12},{wch:14},{wch:11},{wch:18},{wch:16},{wch:14},
    {wch:38},{wch:30},{wch:16},{wch:14},{wch:30}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Trasee');
  XLSX.writeFile(wb, `trasee_curieri_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// -------------------------------------------------------------------
// UTILS
// -------------------------------------------------------------------
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
