/**
 * postavke.js — stranica s postavkama proširenja
 *
 * Omogućuje uključivanje i isključivanje izvora, uređivanje popisa praćenih
 * stranica i izvođača te uvid u dnevnik dohvata, koji služi kao osnova za
 * vrednovanje rada sustava.
 */

import { db, inicijalizirajIzvore, normaliziraj } from '../db.js';

const el = (id) => document.getElementById(id);

/* Izvori  */

async function prikaziIzvore() {
  const izvori = await db.izvori.toArray();

  el('popis-izvora').innerHTML = izvori.map((i) => `
    <div class="red">
      <input type="checkbox" data-izvor="${i.id}" ${i.omogucen ? 'checked' : ''}>
      <span class="ime">${i.naziv}</span>
      <span class="stanje-izvora">
        ${i.zadnjeIzvrsavanje
          ? `${new Date(i.zadnjeIzvrsavanje).toLocaleString('hr-HR')} — ${i.zadnjeStanje ?? ''}`
          : 'još nije pokrenut'}
      </span>
    </div>`).join('');
}

el('popis-izvora').addEventListener('change', async (e) => {
  const id = e.target.dataset.izvor;
  if (!id) return;
  await db.izvori.update(id, { omogucen: e.target.checked ? 1 : 0 });
});

/* Praćene stranice  */

/** Vraća zapis izvora koji objedinjuje ručno dodane stranice */
async function izvorStranica() {
  return db.izvori.get('jsonld');
}

async function prikaziStranice() {
  const izvor = await izvorStranica();
  const stranice = izvor?.postavke?.stranice ?? [];
  const nadzor = await db.nadzor.toArray();
  const poUrl = new Map(nadzor.map((n) => [n.url, n]));

  el('popis-stranica').innerHTML = stranice.length
    ? stranice.map((s) => {
        const n = poUrl.get(s.url);
        const zadnji = n?.zadnjaProvjera
          ? new Date(n.zadnjaProvjera).toLocaleDateString('hr-HR')
          : null;

        return `
          <div class="red">
            <span class="ime">${s.naziv ?? s.url}<br>
              <span class="meta">${s.url}</span>
            </span>
            <span class="stanje-izvora">
              ${zadnji ? `provjereno ${zadnji}` : 'još nije provjereno'}
            </span>
            <button class="gumb-osvjezi" data-ukloni-url="${s.url}">Ukloni</button>
          </div>`;
      }).join('')
    : '<p class="meta">Nijedna stranica još nije dodana.</p>';
}

el('dodaj-stranicu').addEventListener('click', async () => {
  const poruka = el('poruka-stranice');
  poruka.textContent = '';

  const url = el('nova-stranica').value.trim();
  const naziv = el('novi-naziv').value.trim();
  const vrsta = el('nova-vrsta').value;

  let podrijetlo;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error();
    podrijetlo = `${u.origin}/*`;
  } catch {
    poruka.textContent = 'Upiši potpunu adresu koja počinje s https://';
    return;
  }

  /*
   * Proširenje unaprijed traži dozvolu samo za izvore ugrađene pri isporuci.
   * Za stranice koje korisnik doda dozvola se traži u trenutku dodavanja, čime
   * se poštuje načelo najmanjih ovlasti: proširenje ni u jednom trenutku nema
   * pristup stranicama koje mu korisnik nije odobrio.
   */
  const odobreno = await chrome.permissions.request({ origins: [podrijetlo] });
  if (!odobreno) {
    poruka.textContent = 'Bez dozvole za tu adresu stranica se ne može dohvatiti.';
    return;
  }

  const izvor = await izvorStranica();
  const stranice = izvor?.postavke?.stranice ?? [];

  if (stranice.some((s) => s.url === url)) {
    poruka.textContent = 'Ta je stranica već na popisu.';
    return;
  }

  stranice.push({ url, naziv: naziv || new URL(url).hostname, vrsta });
  await db.izvori.update('jsonld', { postavke: { ...izvor.postavke, stranice } });

  el('nova-stranica').value = '';
  el('novi-naziv').value = '';
  await prikaziStranice();
  await prikaziPodrucja();
});

el('popis-stranica').addEventListener('click', async (e) => {
  const url = e.target.dataset.ukloniUrl;
  if (!url) return;

  const izvor = await izvorStranica();
  const stranice = (izvor?.postavke?.stranice ?? []).filter((s) => s.url !== url);

  await db.izvori.update('jsonld', { postavke: { ...izvor.postavke, stranice } });
  await db.nadzor.delete(url);
  await prikaziStranice();
  await prikaziPodrucja();
});

/* Područja na Resident Advisoru  */

async function prikaziPodrucja() {
  const izvor = await db.izvori.get('ra');
  const podrucja = izvor?.postavke?.podrucja ?? [];

  el('popis-podrucja').innerHTML = podrucja.length
    ? podrucja.map((p) => `
        <div class="red">
          <span class="ime">${p.grad}</span>
          <span class="stanje-izvora">područje ${p.id}</span>
          <button class="gumb-osvjezi" data-ukloni-podrucje="${p.id}">Ukloni</button>
        </div>`).join('')
    : '<p class="meta">Nijedno područje još nije dodano.</p>';
}

el('dodaj-podrucje').addEventListener('click', async () => {
  const poruka = el('poruka-podrucje');
  poruka.textContent = '';

  const id = Number(el('novo-podrucje').value.trim());
  const grad = el('novi-grad').value.trim();

  if (!Number.isInteger(id) || id <= 0) {
    poruka.textContent = 'Broj područja mora biti cijeli pozitivan broj.';
    return;
  }
  if (!grad) {
    poruka.textContent = 'Upiši naziv grada, jer ga sučelje ne vraća.';
    return;
  }

  const izvor = await db.izvori.get('ra');
  const podrucja = izvor?.postavke?.podrucja ?? [];

  if (podrucja.some((p) => p.id === id)) {
    poruka.textContent = 'To je područje već na popisu.';
    return;
  }

  podrucja.push({ id, grad });
  await db.izvori.update('ra', { postavke: { ...izvor.postavke, podrucja } });

  el('novo-podrucje').value = '';
  el('novi-grad').value = '';
  await prikaziPodrucja();
});

el('popis-podrucja').addEventListener('click', async (e) => {
  const id = Number(e.target.dataset.ukloniPodrucje);
  if (!id) return;

  const izvor = await db.izvori.get('ra');
  const podrucja = (izvor?.postavke?.podrucja ?? []).filter((p) => p.id !== id);

  await db.izvori.update('ra', { postavke: { ...izvor.postavke, podrucja } });
  await prikaziPodrucja();
});

/* Praćeni izvođači  */

async function prikaziIzvodace() {
  const praceni = await db.izvodaci.where('pracen').equals(1).toArray();

  el('popis-izvodaca').innerHTML = praceni.length
    ? praceni.map((i) => `
        <div class="red">
          <span class="ime">${i.naziv}</span>
          <button class="gumb-osvjezi" data-ukloni="${i.id}">Ukloni</button>
        </div>`).join('')
    : '<p class="meta">Nijedan izvođač još nije dodan.</p>';
}

el('dodaj-izvodaca').addEventListener('click', async () => {
  const naziv = el('novi-izvodac').value.trim();
  if (!naziv) return;

  const nazivNorm = normaliziraj(naziv);
  const postojeci = await db.izvodaci.where('nazivNorm').equals(nazivNorm).first();

  if (postojeci) await db.izvodaci.update(postojeci.id, { pracen: 1 });
  else await db.izvodaci.add({ naziv, nazivNorm, aliasi: [], pracen: 1, slika: null, vanjskiIds: {} });

  el('novi-izvodac').value = '';
  await prikaziIzvodace();
});

el('popis-izvodaca').addEventListener('click', async (e) => {
  const id = Number(e.target.dataset.ukloni);
  if (!id) return;
  await db.izvodaci.update(id, { pracen: 0 });
  await prikaziIzvodace();
});

/* Ključ za Ticketmaster */

async function prikaziKljucTm() {
  const izvor = await db.izvori.get('ticketmaster');
  el('tm-kljuc').value = izvor?.postavke?.kljuc ?? '';
}

el('spremi-tm').addEventListener('click', async () => {
  const vrijednost = el('tm-kljuc').value.trim();
  const izvor = await db.izvori.get('ticketmaster');
  if (!izvor) return;

  await db.izvori.update('ticketmaster', {
    postavke: { ...izvor.postavke, kljuc: vrijednost || null },
    omogucen: vrijednost ? 1 : 0,
  });

  el('poruka-tm').textContent = vrijednost
    ? 'Ključ spremljen, izvor je uključen.'
    : 'Ključ uklonjen, izvor je isključen.';
  await prikaziIzvore();
});

/* Identifikator aplikacije za Bandsintown  */

async function prikaziAppId() {
  const izvor = await db.izvori.get('bandsintown');
  el('bit-appid').value = izvor?.postavke?.appId ?? '';
}

el('spremi-appid').addEventListener('click', async () => {
  const vrijednost = el('bit-appid').value.trim();
  const izvor = await db.izvori.get('bandsintown');
  if (!izvor) return;

  await db.izvori.update('bandsintown', {
    postavke: { ...izvor.postavke, appId: vrijednost || null },
    omogucen: vrijednost ? 1 : 0,
  });
  await prikaziIzvore();
});

/* Dnevnik dohvata  */
async function prikaziDnevnik() {
  const zapisi = await db.dnevnik.reverse().limit(20).toArray();

  el('dnevnik').innerHTML = zapisi.length
    ? zapisi.map((z) => `
        <div class="red">
          <span class="ime">${z.izvorId}${izvjestajUKratko(z.izvjestaj)}</span>
          <span class="stanje-izvora">
            ${new Date(z.pokrenuto).toLocaleString('hr-HR')} ·
            ${z.trajanjeMs} ms · ${z.dohvaceno} zapisa ·
            ${z.novih} novih · ${z.azuriranih ?? 0} osvježenih · ${z.duplikata} duplikata${z.preskoceno ? ` · ${z.preskoceno} preskočeno` : ''}
            ${z.greska ? `<br><span class="znak lose">${z.greska}</span>` : ''}
          </span>
        </div>`).join('')
    : '<p class="meta">Dohvat još nije pokrenut.</p>';
}

/** Sažima izvještaj po stranicama u niz oznaka ispod naziva izvora */
function izvjestajUKratko(izvjestaj) {
  if (!Array.isArray(izvjestaj) || !izvjestaj.length) return '';

  const oznake = izvjestaj.map((s) => {
    if (s.greska) return `<span class="znak lose">${s.naziv}: greška</span>`;
    if (s.dogadanja && s.izTeksta) {
      return `<span class="znak dobar">${s.naziv}: ${s.dogadanja} iz teksta</span>`;
    }
    if (s.dogadanja) {
      return `<span class="znak dobar">${s.naziv}: ${s.dogadanja} strukturirano</span>`;
    }
    if (s.objekata) {
      return `<span class="znak">${s.naziv}: ${s.objekata} zapisa bez datuma</span>`;
    }
    if (s.promijenjeno) return `<span class="znak dobar">${s.naziv}: promjena</span>`;
    return `<span class="znak">${s.naziv}: bez podataka</span>`;
  });

  return `<div class="oznake" style="margin-top:6px">${oznake.join(' ')}</div>`;
}

/* -------- */

(async function pokreni() {
  /* Verzija se ispisuje kako bi se na prvi pogled vidjelo koje je izdanje učitano */
  el('verzija').textContent = `v${chrome.runtime.getManifest().version}`;

  await inicijalizirajIzvore();
  await prikaziIzvore();
  await prikaziStranice();
  await prikaziPodrucja();
  await prikaziIzvodace();
  await prikaziKljucTm();
  await prikaziAppId();
  await prikaziDnevnik();
})();
