/**
 * izvori/index.js — usmjeravanje prema pojedinom konektoru
 *
 * Izvodi se u skrivenom dokumentu. Svaki izvor podataka opisan je zapisom u
 * tablici izvora, a ne zasebnom granom u kodu; ova datoteka na temelju
 * identifikatora izvora odabire odgovarajući konektor.
 *
 * Moduli se učitavaju statički, na vrhu datoteke, jer specifikacija uslužnih
 * radnika ne dopušta dinamičko učitavanje izrazom import().
 */

import * as entrio from './entrio.js';
import * as ra from './ra.js';
import * as jsonld from './jsonld.js';
import * as bandsintown from './bandsintown.js';
import * as ticketmaster from './ticketmaster.js';

const KONEKTORI = {
  entrio,
  ra,
  jsonld,
  bandsintown,
  ticketmaster,
};

/**
 * Pokreće dohvat s jednog izvora i vraća zapise svedene na jedinstvenu shemu.
 * Upis u bazu namjerno se ne obavlja ovdje, nego u uslužnom radniku, kako bi
 * ovaj sloj ostao ograničen isključivo na prikupljanje podataka.
 *
 * @param {object} izvor — zapis iz tablice izvora
 * @returns {Promise<object[]>}
 */
export async function prikupiSIzvora(izvor) {
  const konektor = KONEKTORI[izvor.id];
  if (!konektor) {
    throw new Error(`Za izvor "${izvor.id}" konektor još nije implementiran.`);
  }
  return konektor.dohvati(izvor);
}

/**
 * Vraća izvještaj konektora o posljednjem prolazu, ako ga konektor nudi.
 * Time se u sučelju može prikazati stanje svake pojedine stranice
 */
export function dohvatiIzvjestaj(izvorId) {
  return KONEKTORI[izvorId]?.dohvatiIzvjestaj?.() ?? null;
}

/**
 * Dohvaća HTML stranice i razrješava ga u dokument nad kojim se mogu
 * primijeniti standardne metode za pretraživanje strukture.
 */
export async function dohvatiDokument(url) {
  const odgovor = await fetch(url, {
    headers: { 'Accept': 'text/html' },
    credentials: 'omit',
  });
  if (!odgovor.ok) {
    throw new Error(`Poslužitelj je vratio stanje ${odgovor.status} za ${url}`);
  }
  return new DOMParser().parseFromString(await odgovor.text(), 'text/html');
}

/** Stanka između uzastopnih zahtjeva prema istom poslužitelju */
export function stanka(ms = 1200) {
  return new Promise((r) => setTimeout(r, ms));
}
