/**
 * izvori/bandsintown.js — konektor za Bandsintown
 *
 * Za razliku od ostalih izvora, Bandsintown nudi službeno programsko sučelje s
 * dokumentiranim krajnjim točkama i imenovanim poljima. Popis izvođača ne
 * navodi se u postavkama izvora, nego se preuzima iz tablice praćenih
 * izvođača, čime dodavanje izvođača u sučelju automatski proširuje i dohvat.
 */

import { db, VRSTE } from '../db.js';
import { stanka } from './index.js';

const OSNOVNI_URL = 'https://rest.bandsintown.com';

/**
 * @param {object} izvor — zapis iz tablice izvora; postavke.appId sadrži
 *   identifikator aplikacije koji sučelje zahtijeva uz svaki zahtjev
 */
export async function dohvati(izvor) {
  const appId = izvor.postavke?.appId;
  if (!appId) {
    throw new Error('Nije upisan identifikator aplikacije. Dodaj ga u postavkama.');
  }

  const izvodaci = await db.izvodaci.where('pracen').equals(1).toArray();
  if (!izvodaci.length) {
    throw new Error('Nijedan izvođač nije praćen, pa nema što dohvatiti.');
  }

  const svi = new Map();

  for (const izvodac of izvodaci) {
    try {
      for (const zapis of await dohvatiZaIzvodaca(izvodac.naziv, appId)) {
        if (!svi.has(zapis.idNaIzvoru)) svi.set(zapis.idNaIzvoru, zapis);
      }
    } catch (greska) {
      console.warn(`Bandsintown: preskačem izvođača ${izvodac.naziv} — ${greska.message}`);
    }
    await stanka(600);
  }

  return [...svi.values()];
}

/** Dohvaća nadolazeće nastupe jednog izvođača. */
async function dohvatiZaIzvodaca(naziv, appId) {
  const url = `${OSNOVNI_URL}/artists/${encodeURIComponent(naziv)}/events/`
    + `?app_id=${encodeURIComponent(appId)}&date=upcoming`;

  const odgovor = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    credentials: 'omit',
  });

  if (!odgovor.ok) {
    throw new Error(`Sučelje je vratilo stanje ${odgovor.status}.`);
  }

  const podaci = await odgovor.json();
  if (!Array.isArray(podaci)) return [];   /* nepoznat izvođač vraća objekt s greškom */

  return podaci.map((d) => pretvori(d, naziv)).filter(Boolean);
}

/* Svođenje na jedinstvenu shemu */

function pretvori(dogadanje, izvodac) {
  if (!dogadanje?.id || !dogadanje?.datetime) return null;

  const mjesto = dogadanje.venue ?? {};
  const naziv = dogadanje.title?.trim()
    || `${izvodac} — ${mjesto.name ?? mjesto.city ?? 'nastup'}`;

  /* Poveznica na prodaju ulaznica ima prednost pred poveznicom na zapis. */
  const ulaznice = (dogadanje.offers ?? []).find((p) => /ticket/i.test(p.type ?? ''));

  return {
    idNaIzvoru: String(dogadanje.id),
    naziv,
    vrsta: dogadanje.festival_start_date ? VRSTE.FESTIVAL : VRSTE.KONCERT,
    pocetak: new Date(dogadanje.datetime).toISOString(),
    kraj: dogadanje.festival_end_date
      ? new Date(dogadanje.festival_end_date).toISOString()
      : null,
    mjesto: {
      naziv: mjesto.name ?? null,
      grad: mjesto.city ?? null,
      drzava: mjesto.country ?? null,
      lat: mjesto.latitude ? Number(mjesto.latitude) : null,
      lng: mjesto.longitude ? Number(mjesto.longitude) : null,
    },
    izvodaci: (dogadanje.lineup?.length ? dogadanje.lineup : [izvodac]).filter(Boolean),
    poveznica: ulaznice?.url ?? dogadanje.url,
    slika: dogadanje.artist?.image_url ?? null,
    opis: dogadanje.description?.trim()?.slice(0, 400) || null,
  };
}
