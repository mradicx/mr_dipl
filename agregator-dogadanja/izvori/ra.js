/**
 * izvori/ra.js — konektor za Resident Advisor
 *
 * Resident Advisor ne objavljuje službeno programsko sučelje, no njegovo web
 * sjedište podatke dohvaća s vlastite krajnje točke koja se koristi jezikom
 * GraphQL. Za razliku od stranica koje se poslužuju kao gotov HTML, ovdje se
 * ne primjenjuje ekstrakcija sadržaja, nego se šalje isti upit kojim se služi
 * i samo sjedište, a odgovor stiže kao strukturirani zapis u formatu JSON.
 *
 * Time se dobiva bitno pouzdaniji izvor: polja su imenovana i tipizirana, pa
 * promjena izgleda stranice ne utječe na obradu. Nedostatak je što se radi o
 * nedokumentiranom sučelju, koje vlasnik može izmijeniti bez najave, na što se
 * upozorava u poglavlju o ograničenjima.
 */

import { stanka } from './index.js';
import { VRSTE } from '../db.js';

const KRAJNJA_TOCKA = 'https://ra.co/graphql';

/**
 * Upit odgovara operaciji kojom se služi samo sjedište pri prikazu popisa
 * događanja. Traže se identifikator, naziv, vrijeme početka i završetka,
 * poveznica, letak, mjesto održavanja i popis izvođača.
 */
const UPIT = `
query GET_EVENT_LISTINGS(
  $filters: FilterInputDtoInput,
  $filterOptions: FilterOptionsInputDtoInput,
  $page: Int,
  $pageSize: Int
) {
  eventListings(filters: $filters, filterOptions: $filterOptions, pageSize: $pageSize, page: $page) {
    data {
      id
      listingDate
      event {
        id
        date
        startTime
        endTime
        title
        contentUrl
        flyerFront
        isTicketed
        venue { id name contentUrl }
        artists { id name }
      }
    }
    totalResults
  }
}`;

const VELICINA_STRANICE = 20;

/*
 * Sučelje vraća događanja poredana po datumu, počevši od najbližeg, pa broj
 * dohvaćenih stranica izravno određuje koliko se daleko u budućnost doseže.
 * Pri niskoj granici dohvat obuhvaća tek nekoliko sljedećih dana, zbog čega
 * događanja najavljena mjesecima unaprijed, poput festivala, uopće ne budu
 * dohvaćena.
 */
const NAJVISE_STRANICA = 20;

/* Dohvat */

/**
 * Dohvaća događanja za sva konfigurirana područja.
 *
 * Područja se u sučelju Resident Advisora označuju brojčanim identifikatorom.
 * U postavkama izvora navode se kao objekti s identifikatorom i nazivom grada,
 * budući da odgovor sučelja ne sadrži podatak o gradu, nego samo o prostoru u
 * kojem se događanje održava.
 *
 * @param {object} izvor — zapis iz tablice izvora
 */
export async function dohvati(izvor) {
  const podrucja = izvor.postavke?.podrucja ?? [];
  if (!podrucja.length) {
    throw new Error('Nije zadano nijedno područje. Dodaj ih u postavkama izvora.');
  }

  const danas = new Date();
  const doDatuma = new Date(danas.getTime() + 120 * 86400000);   /* četiri mjeseca unaprijed */

  const svi = new Map();

  for (const podrucje of podrucja) {
    for (let stranica = 1; stranica <= NAJVISE_STRANICA; stranica += 1) {
      const odgovor = await posaljiUpit({
        podrucje: podrucje.id,
        od: danas.toISOString().slice(0, 10),
        do: doDatuma.toISOString().slice(0, 10),
        stranica,
      });

      const stavke = odgovor?.data?.eventListings?.data ?? [];
      if (!stavke.length) break;

      for (const stavka of stavke) {
        const zapis = pretvori(stavka.event, podrucje.grad);
        if (zapis && !svi.has(zapis.idNaIzvoru)) svi.set(zapis.idNaIzvoru, zapis);
      }

      const ukupno = odgovor?.data?.eventListings?.totalResults ?? 0;
      if (stranica * VELICINA_STRANICE >= ukupno) break;

      await stanka(400);
    }
  }

  return [...svi.values()];
}

/** Šalje jedan upit i vraća razriješen odgovor */
async function posaljiUpit({ podrucje, od, do: doDatuma, stranica }) {
  const tijelo = {
    operationName: 'GET_EVENT_LISTINGS',
    variables: {
      filters: {
        areas: { eq: podrucje },
        listingDate: { gte: od, lte: doDatuma },
      },
      filterOptions: { genre: true },
      pageSize: VELICINA_STRANICE,
      page: stranica,
    },
    query: UPIT,
  };

  /*
   * Zaglavlja Referer i User-Agent, koja se navode u postojećim rješenjima
   * pisanima izvan preglednika, ovdje se ne postavljaju: specifikacija ih
   * ubraja u zabranjena zaglavlja, pa ih preglednik popunjava sam.
   */
  const odgovor = await fetch(KRAJNJA_TOCKA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tijelo),
    credentials: 'omit',
  });

  if (!odgovor.ok) {
    throw new Error(`Resident Advisor je vratio stanje ${odgovor.status}.`);
  }

  const podaci = await odgovor.json();
  if (podaci.errors?.length) {
    throw new Error(`Upit je odbijen: ${podaci.errors[0].message}`);
  }
  return podaci;
}


/* Svođenje na jedinstvenu shemu                                       */

/**
 * Većina zapisa na Resident Advisoru odnosi se na klupska događanja, pa se ta
 * vrsta uzima kao zadana. Festivali se prepoznaju po nazivu, budući da sučelje
 * ne vraća podatak o vrsti događanja.
 */
function odrediVrstu(naslov) {
  return /\bfestival\b/i.test(naslov ?? '') ? VRSTE.FESTIVAL : VRSTE.DJ_PARTY;
}

function pretvori(dogadanje, grad) {
  if (!dogadanje?.id || !dogadanje?.title) return null;

  const pocetak = dogadanje.startTime ?? dogadanje.date;
  if (!pocetak) return null;

  return {
    idNaIzvoru: String(dogadanje.id),
    naziv: dogadanje.title,
    vrsta: odrediVrstu(dogadanje.title),
    pocetak: new Date(pocetak).toISOString(),
    kraj: dogadanje.endTime ? new Date(dogadanje.endTime).toISOString() : null,
    mjesto: {
      naziv: dogadanje.venue?.name ?? null,
      grad,
      drzava: null,
    },
    izvodaci: (dogadanje.artists ?? []).map((i) => i.name).filter(Boolean),
    poveznica: dogadanje.contentUrl
      ? new URL(dogadanje.contentUrl, 'https://ra.co').href
      : 'https://ra.co',
    slika: dogadanje.flyerFront ?? null,
    opis: null,
  };
}
