/**
 * offscreen.js — prikupljanje podataka u skrivenom dokumentu
 *
 * Uslužni radnik nema pristup objektnom modelu dokumenta, pa se dohvat i
 * ekstrakcija sadržaja odvijaju ovdje. Budući da je baza podataka zajednička
 * svim kontekstima proširenja, skriveni dokument prikupljene zapise upisuje
 * izravno, bez vraćanja podataka radniku.
 *
 * Takva podjela uklanja potrebu za dugotrajnim kanalom poruke. Preglednik
 * zatvara kanal nakon kratkog razdoblja, pa bi čekanje na odgovor tijekom
 * dohvata, koji traje i više od deset sekundi, redovito završilo pogreškom.
 */

import { db, inicijalizirajIzvore, upisiDogadanje, zabiljeziDohvat } from '../db.js';
import { prikupiSIzvora, dohvatiIzvjestaj } from '../izvori/index.js';

/* Sprječava istodobno pokretanje dvaju prikupljanja */
let uTijeku = false;

chrome.runtime.onMessage.addListener((poruka) => {
  /* Odgovor se namjerno ne vraća: pošiljatelj ne čeka rezultat */
  if (poruka?.tip === 'prikupi-sve') prikupiSve(poruka.prisilno === true);
});

/**
 * Prolazi kroz sve uključene izvore i prikuplja podatke s onih kojima je
 * isteklo razdoblje između dva izvršavanja. Izvori se obrađuju redom, kako se
 * ne bi opteretile ciljane stranice.
 *
 * @param {boolean} prisilno — zanemaruje zadano razdoblje između dohvata
 */
async function prikupiSve(prisilno) {
  if (uTijeku) return;
  uTijeku = true;

  try {
    await inicijalizirajIzvore();
    const izvori = await db.izvori.where('omogucen').equals(1).toArray();
    const sada = Date.now();

    for (const izvor of izvori) {
      const zadnje = izvor.zadnjeIzvrsavanje ? Date.parse(izvor.zadnjeIzvrsavanje) : 0;
      const isteklo = sada - zadnje >= (izvor.intervalMin ?? 360) * 60000;
      if (!prisilno && !isteklo) continue;

      await obradiIzvor(izvor);
    }
  } finally {
    uTijeku = false;
    /* Radnik na ovu poruku zatvara skriveni dokument i obavještava sučelje */
    chrome.runtime.sendMessage({ tip: 'prikupljanje-gotovo' }).catch(() => {});
  }
}

/** Prikuplja i upisuje zapise s jednog izvora te bilježi ishod u dnevnik */
async function obradiIzvor(izvor) {
  const pocetak = performance.now();
  const rezultat = {
    pokrenuto: new Date().toISOString(),
    trajanjeMs: 0, dohvaceno: 0, novih: 0, azuriranih: 0, duplikata: 0, preskoceno: 0, greska: null,
  };

  try {
    const zapisi = await prikupiSIzvora(izvor);
    rezultat.dohvaceno = zapisi.length;

    for (const zapis of zapisi) {
      const ishod = await upisiDogadanje({ ...zapis, izvorId: izvor.id });
      if (ishod.preskocen) rezultat.preskoceno += 1;
      else if (ishod.duplikat) rezultat.duplikata += 1;
      else if (ishod.postojao) rezultat.azuriranih += 1;
      else rezultat.novih += 1;
    }
  } catch (greska) {
    /*
     * Poruka se sastavlja iz imena i opisa iznimke. Bez toga se iznimka koja
     * je objekt prikazuje kao "[object Object]", što ne otkriva uzrok.
     */
    rezultat.greska = [greska?.name, greska?.message ?? greska?.inner?.message]
      .filter(Boolean).join(': ') || String(greska);
    console.error(`Prikupljanje s izvora ${izvor.id} nije uspjelo:`, greska);
  }

  rezultat.trajanjeMs = Math.round(performance.now() - pocetak);
  rezultat.izvjestaj = dohvatiIzvjestaj(izvor.id);
  await zabiljeziDohvat(izvor.id, rezultat);
}
