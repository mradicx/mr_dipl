/**
 * service-worker.js
 *Iz dokumentacije/za rad
 * Service worker u Manifestu V3 nije trajno pokrenut.
 * Preglednik ga pokreće po potrebi i gasi nakon razdoblja neaktivnosti, zbog
 * čega se stanje ne smije čuvati u varijablama, nego u bazi podataka.
 * Periodičko izvršavanje ostvaruje se sučeljem chrome.alarms, koje preglednik
 * održava i kad radnik nije pokrenut.
 *
 * Radnik ovdje ima ulogu raspoređivača: pokreće skriveni dokument koji obavlja
 * prikupljanje, a nakon njegove dojave zatvara ga te šalje obavijesti i uklanja
 * istekle zapise. Nijedna poruka ne čeka odgovor, čime se izbjegava zatvaranje
 * kanala tijekom dugotrajnog dohvata.
 */

import { db, inicijalizirajIzvore } from '../db.js';

const ALARM = 'periodicki-dohvat';
const SKRIVENI = 'offscreen/offscreen.html';

/* Životni ciklus */


chrome.runtime.onInstalled.addListener(async () => {
  await inicijalizirajIzvore();
  chrome.alarms.create(ALARM, { periodInMinutes: 60 });
  pokreni(false);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 60 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) pokreni(false);
});

chrome.runtime.onMessage.addListener((poruka) => {
  /* Nijedna grana ne vraća true — nijedan kanal ne ostaje otvoren */
  if (poruka?.tip === 'osvjezi-sve') pokreni(poruka.prisilno === true);
  if (poruka?.tip === 'prikupljanje-gotovo') zavrsi();
});

/* Pokretanje prikupljanja */

/** Stvara skriveni dokument, ako već ne postoji, i nalaže mu prikupljanje */
async function pokreni(prisilno) {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: SKRIVENI,
        reasons: ['DOM_PARSER'],
        justification: 'Razrješavanje HTML-a pri ekstrakciji podataka o događanjima.',
      });
    }
    await posalji({ tip: 'prikupi-sve', prisilno });
  } catch (greska) {
    console.error('Pokretanje prikupljanja nije uspjelo:', greska);
    obavijestiSucelje();
  }
}

/**
 * Šalje poruku skrivenom dokumentu. Stvaranje dokumenta dovršeno je prije nego
 * što se izvede njegova skripta, pa se slanje ponavlja dok se ne registrira
 * primatelj poruke
 */
async function posalji(poruka, pokusaja = 15) {
  for (let i = 0; i < pokusaja; i += 1) {
    try {
      await chrome.runtime.sendMessage(poruka);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('Skriveni dokument nije preuzeo zadatak.');
}

/* Dovršetak prikupljanja  */

async function zavrsi() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
  await obavijestiOPracenima();
  await obavijestiOPromjenama();
  await ocistiStara();
  obavijestiSucelje();
}

/** Javlja skočnom prozoru da može ponovno iscrtati popis */
function obavijestiSucelje() {
  chrome.runtime.sendMessage({ tip: 'osvjezavanje-gotovo' }).catch(() => {});
}

/* Obavijesti i održavanje */

/**
 * Šalje obavijest kad se pojavi novo događanje izvođača kojega korisnik prati.
 * Već prijavljena događanja pamte se kako se obavijest ne bi ponavljala pri
 * svakom sljedećem dohvatu.
 */
async function obavijestiOPracenima() {
  const praceni = await db.izvodaci.where('pracen').equals(1).primaryKeys();
  if (!praceni.length) return;

  const skup = new Set(praceni);
  const { prijavljena = [] } = await chrome.storage.local.get('prijavljena');
  const vecPrijavljena = new Set(prijavljena);

  const nova = await db.dogadanja
    .where('pocetak').above(new Date().toISOString())
    .filter((d) => d.izvodaciIds.some((id) => skup.has(id)) && !vecPrijavljena.has(d.id))
    .toArray();

  for (const d of nova.slice(0, 5)) {
    chrome.notifications.create(d.id, {
      type: 'basic',
      iconUrl: '../ikone/128.png',
      title: 'Novo događanje praćenog izvođača',
      message: `${d.naziv} — ${d.grad ?? ''}`,
    });
    vecPrijavljena.add(d.id);
  }

  await chrome.storage.local.set({ prijavljena: [...vecPrijavljena].slice(-500) });
}

/**
 * Obavještava o stranicama kojima se promijenio sadržaj. Za stranice koje ne
 * objavljuju strukturirane podatke to je jedini način da korisnik sazna za
 * objavu programa ili početak prodaje ulaznica.
 */
async function obavijestiOPromjenama() {
  const promijenjene = await db.nadzor.where('promijenjeno').equals(1).toArray();

  for (const stranica of promijenjene.slice(0, 5)) {
    chrome.notifications.create(`nadzor:${stranica.url}`, {
      type: 'basic',
      iconUrl: '../ikone/128.png',
      title: 'Promjena na praćenoj stranici',
      message: `${stranica.naziv ?? stranica.url} — provjeri ima li novosti.`,
    });
    /* Zastavica se briše kako se ista promjena ne bi prijavila dvaput */
    await db.nadzor.update(stranica.url, { promijenjeno: 0 });
  }
}

/** Uklanja događanja koja su prošla prije više od tjedan dana */
async function ocistiStara() {
  const granica = new Date(Date.now() - 7 * 86400000).toISOString();
  await db.dogadanja.where('pocetak').below(granica).delete();
}

/* Klik na obavijest otvara stranicu događanja */
chrome.notifications.onClicked.addListener(async (id) => {
  if (id.startsWith('nadzor:')) {
    chrome.tabs.create({ url: id.slice('nadzor:'.length) });
    return;
  }
  const d = await db.dogadanja.get(id);
  if (d?.poveznica) chrome.tabs.create({ url: d.poveznica });
});
