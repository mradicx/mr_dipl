/**
 * popup.js - logika sučelja proširenja
 *
 * Sučelje ne dohvaća podatke s interneta. Ono isključivo čita iz lokalne baze,
 * koju u pozadini popunjava uslužni radnik, zbog čega se popis prikazuje
 * odmah, bez čekanja na mrežu.
 *
 * Ista se datoteka koristi za skočni prozor i za prikaz u zasebnoj kartici;
 * razlikuju se samo oblikovanjem i izostavljanjem oznaka dana.
 */

import { db, dohvatiDogadanja, inicijalizirajIzvore, VRSTE, BEZ_GRADA } from '../db.js';

/* Trenutno stanje filtara. */
const stanje = {
  vrsta: 'sve',
  grad: '',
  izvor: '',
  samoPraceni: false,
  pretraga: '',
};

const el = (id) => document.getElementById(id);

/* Način prikaza */

/*
 * Način prikaza prenosi se parametrom u adresi, a oblikovanje se prilagođava
 * razredom na tijelu dokumenta, čime se izbjegava udvostručavanje sučelja.
 */
const uKartici = new URLSearchParams(location.search).get('prikaz') === 'kartica';

if (uKartici) {
  document.body.classList.add('kartica');
  el('u-karticu').hidden = true;
} else {
  el('u-karticu').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?prikaz=kartica') });
    window.close();
  });
}

/* Pomoćne funkcije za prikaz */

const MJESECI = ['sij', 'velj', 'ožu', 'tra', 'svi', 'lip',
                 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro'];
const DANI = ['ned', 'pon', 'uto', 'sri', 'čet', 'pet', 'sub'];
const DANI_PUNI = ['nedjelja', 'ponedjeljak', 'utorak', 'srijeda',
                   'četvrtak', 'petak', 'subota'];

/** Vraća broj dana između danas i zadanog datuma. */
function razmakDana(iso) {
  const danas = new Date(); danas.setHours(0, 0, 0, 0);
  const d = new Date(iso);  d.setHours(0, 0, 0, 0);
  return Math.round((d - danas) / 86400000);
}

/** Čitljiv opis dana: "danas", "sutra" ili "petak, 17. srp 2026." */
function opisDana(iso) {
  const r = razmakDana(iso);
  if (r === 0) return 'danas';
  if (r === 1) return 'sutra';
  const d = new Date(iso);
  return `${DANI_PUNI[d.getDay()]}, ${d.getDate()}. ${MJESECI[d.getMonth()]} ${d.getFullYear()}.`;
}

function vrijeme(iso) {
  return new Date(iso).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
}

const NAZIVI_VRSTA = {
  [VRSTE.KONCERT]: 'koncert',
  [VRSTE.DJ_PARTY]: 'klupsko',
  [VRSTE.FESTIVAL]: 'festival',
  [VRSTE.PREDSTAVA]: 'predstava',
  [VRSTE.STAND_UP]: 'stand-up',
  [VRSTE.FILM]: 'kino',
  [VRSTE.IZLOZBA]: 'izložba',
  [VRSTE.SPORT]: 'sport',
  [VRSTE.OSTALO]: 'ostalo',
};

const NAZIVI_IZVORA = {
  entrio: 'Entrio',
  ra: 'Resident Advisor',
  ticketmaster: 'Ticketmaster',
  jsonld: 'Stranice',
  bandsintown: 'Bandsintown',
};

/** Sprječava da naziv s posebnim znakovima naruši strukturu stranice */
function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (z) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]
  ));
}

/* Iscrtavanje popisa */

async function prikazi() {
  const dogadanja = await dohvatiDogadanja({
    vrste: stanje.vrsta === 'sve' ? null : [stanje.vrsta],
    gradovi: stanje.grad ? [stanje.grad] : null,
    izvori: stanje.izvor ? [stanje.izvor] : null,
    samoPraceni: stanje.samoPraceni,
  });

  const upit = stanje.pretraga.trim().toLowerCase();
  const konacno = upit
    ? dogadanja.filter((d) => d.naziv.toLowerCase().includes(upit))
    : dogadanja;

  el('broj-rezultata').textContent = konacno.length
    ? `${konacno.length} događanja`
    : '';

  if (!konacno.length) {
    el('popis').innerHTML =
      `<p class="stanje">Nema događanja koja odgovaraju odabranim filtrima.<br>
       Ukloni koji filtar ili klikni Osvježi.</p>`;
    return;
  }

  /* Zapisi se grupiraju po danu radi oznaka dana u skočnom prozoru */
  const poDanima = new Map();
  for (const d of konacno) {
    const kljuc = d.pocetak.slice(0, 10);
    if (!poDanima.has(kljuc)) poDanima.set(kljuc, []);
    poDanima.get(kljuc).push(d);
  }

  const dijelovi = [];
  for (const [dan, stavke] of poDanima) {
    const blizu = razmakDana(dan) <= 1;
    dijelovi.push(`<h2 class="dan ${blizu ? 'blizu' : ''}">${opisDana(dan)}</h2>`);
    for (const d of stavke) dijelovi.push(redak(d, blizu));
  }

  el('popis').innerHTML = dijelovi.join('');
}

/** Sastavlja HTML jednog retka popisa */
function redak(d, blizu) {
  const datum = new Date(d.pocetak);

  /*
   * Dio izvora ne navodi grad, osobito kod festivala izvan naselja. Takva se
   * događanja ne izostavljaju, nego se prikazuju s nazivom prostora, a ako ni
   * on nije poznat, s izričitom napomenom.
   */
  const lokacija = d.grad
    ? (d.mjestoNaziv && d.mjestoNaziv !== d.grad ? `${d.mjestoNaziv}, ${d.grad}` : d.grad)
    : (d.mjestoNaziv ?? 'lokacija nije navedena');

  const meta = [escapeHtml(lokacija), vrijeme(d.pocetak)];
  if (d.cijenaOd != null) {
    meta.push(`<span class="cijena">od ${d.cijenaOd} ${escapeHtml(d.valuta ?? '')}</span>`);
  }

  const izvori = [...new Set(d.izvori.map((i) => NAZIVI_IZVORA[i.izvorId] ?? i.izvorId))];

  /* U kartici stupac s datumom nosi i dan u tjednu, jer oznaka dana izostaje */
  const danUTjednu = uKartici
    ? `<span class="mjesec">${DANI[datum.getDay()]}</span>`
    : '';

  return `
    <a class="dogadanje ${blizu ? 'blizu' : ''}" href="${escapeHtml(d.poveznica)}"
       target="_blank" rel="noreferrer">
      <div class="stupac-datum">
        <span class="broj">${datum.getDate()}</span>
        <span class="mjesec">${MJESECI[datum.getMonth()]}</span>
        ${danUTjednu}
      </div>
      <div>
        <p class="vrsta">${NAZIVI_VRSTA[d.vrsta] ?? d.vrsta}</p>
        <h3 class="naziv-dogadanja">${escapeHtml(d.naziv)}</h3>
        <p class="meta">${meta.join(' · ')}</p>
      </div>
      <span class="izvor">${escapeHtml(izvori.join(' · '))}</span>
    </a>`;
}

/* Popunjavanje izbornika */

async function popuniIzbornike() {
  const gradovi = new Set();
  const izvori = new Set();
  let bezGrada = 0;

  await db.dogadanja.each((d) => {
    if (d.grad) gradovi.add(d.grad); else bezGrada += 1;
    if (d.izvorId) izvori.add(d.izvorId);
  });

  const poredani = [...gradovi].sort((a, b) => a.localeCompare(b, 'hr'));

  el('filtar-grad').innerHTML =
    '<option value="">Svi gradovi</option>'
    + poredani.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')
    + (bezGrada ? `<option value="${BEZ_GRADA}">Bez grada (${bezGrada})</option>` : '');

  el('filtar-izvor').innerHTML =
    '<option value="">Svi izvori</option>'
    + [...izvori].sort().map((i) =>
        `<option value="${escapeHtml(i)}">${escapeHtml(NAZIVI_IZVORA[i] ?? i)}</option>`
      ).join('');

  /* Odabir se zadržava nakon osvježavanja popisa. */
  el('filtar-grad').value = stanje.grad;
  el('filtar-izvor').value = stanje.izvor;
}

/* Reakcije na korisničke radnje */

el('filtri-vrsta').addEventListener('click', (e) => {
  const gumb = e.target.closest('.cip');
  if (!gumb) return;
  el('filtri-vrsta').querySelectorAll('.cip').forEach((g) => g.classList.remove('aktivan'));
  gumb.classList.add('aktivan');
  stanje.vrsta = gumb.dataset.vrsta;
  prikazi();
});

el('filtar-grad').addEventListener('change', (e) => { stanje.grad = e.target.value; prikazi(); });
el('filtar-izvor').addEventListener('change', (e) => { stanje.izvor = e.target.value; prikazi(); });

el('samo-praceni').addEventListener('click', (e) => {
  stanje.samoPraceni = !stanje.samoPraceni;
  e.currentTarget.setAttribute('aria-pressed', String(stanje.samoPraceni));
  prikazi();
});

/* Odgoda sprječava iscrtavanje popisa nakon svakog pritiska tipke */
let odgoda;
el('pretraga').addEventListener('input', (e) => {
  clearTimeout(odgoda);
  const v = e.target.value;
  odgoda = setTimeout(() => { stanje.pretraga = v; prikazi(); }, 150);
});

/**
 * Prikupljanje traje dulje nego što preglednik drži kanal poruke otvorenim, pa
 * se zahtjev šalje bez čekanja odgovora. Dovršetak se doznaje iz zasebne
 * poruke koju pozadinski proces pošalje po završetku.
 */
let cekanje;

el('osvjezi').addEventListener('click', () => {
  el('osvjezi').disabled = true;
  el('osvjezi').textContent = 'Dohvaćam…';

  chrome.runtime.sendMessage({ tip: 'osvjezi-sve', prisilno: true }).catch(() => {});

  clearTimeout(cekanje);
  cekanje = setTimeout(zavrsiOsvjezavanje, 180000);
});

chrome.runtime.onMessage.addListener((poruka) => {
  if (poruka?.tip === 'osvjezavanje-gotovo') zavrsiOsvjezavanje();
});

async function zavrsiOsvjezavanje() {
  clearTimeout(cekanje);
  await popuniIzbornike();
  await prikazi();
  el('osvjezi').disabled = false;
  el('osvjezi').textContent = 'Osvježi';
}

el('otvori-postavke').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

/* Pokretanje  */


(async function pokreni() {
  el('verzija-popup').textContent = `v${chrome.runtime.getManifest().version}`;

  await inicijalizirajIzvore();
  await popuniIzbornike();
  await prikazi();
})();
