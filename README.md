# Agregator događanja

Proširenje web preglednika koje s više izvora prikuplja informacije o događanjima (koncerti, predstave, festivali), svodi ih na jedinstven oblik, prepoznaje isti događaj prijavljen s više izvora i prikazuje sve na jednom mjestu - u kalendaru unutar preglednika. Sve se izvodi lokalno na uređaju korisnika, bez poslužitelja.

Proširenje je izrađeno u sklopu diplomskog rada.

## Kako radi

Podaci o događanjima dostupni su na tri razine, ovisno o tome koliko su spremni za strojno čitanje:

1. **Službeno programsko sučelje** - dokumentirano i stabilno (Ticketmaster).
2. **Nedokumentirano sučelje** - postoji i strukturirano je, ali nije službeno (Resident Advisor, GraphQL).
3. **Ekstrakcija sadržaja** - nema sučelja, podaci se izvlače iz HTML-a namijenjenog ljudima (Entrio, stranice organizatora).

Prikupljanje se pokreće periodički u pozadini. Za svaki izvor odgovarajući konektor dohvaća podatke, koji se potom svode na jedinstveni model, normaliziraju i provjeravaju na duplikate. Isti događaj prijavljen s više izvora povezuje se zajedničkim identifikatorom, čime se čuvaju sve poveznice na ulaznice, a korisniku se prikazuje jedan unos. Podaci se pohranjuju u bazu unutar preglednika.

## Struktura projekta

```
manifest.json            iskaznica proširenja (Manifest V3)
db.js                    obrada i pohrana: model, normalizacija, deduplikacija, baza
background/
  service-worker.js      pozadinski proces: periodičko pokretanje prikupljanja
offscreen/               skriveni dokument s pristupom DOM-u (razrješavanje HTML-a)
izvori/                  konektori za pojedine izvore
  index.js               zajedničke pomoćne funkcije (dohvat, razrješavanje)
  entrio.js              Entrio — ekstrakcija iz HTML-a
  ra.js                  Resident Advisor — GraphQL
  ticketmaster.js        Ticketmaster — službeni API
  bandsintown.js         Bandsintown — izrađen, isključen zbog uvjeta korištenja
  jsonld.js              konfigurabilni ekstraktor za ručno dodane stranice
popup/                   glavni prikaz: kalendar, pretraga, filtri
postavke/                postavke: izvori, praćene stranice, dnevnik dohvata
lib/
  dexie.mjs              Dexie.js — jedina vanjska biblioteka (sloj nad IndexedDB)
ikone/                   ikone proširenja
```

## Pokretanje

Proširenje je pisano čistim JavaScriptom, bez razvojnog okvira i bez koraka prevođenja, pa se pokreće izravno:

1. Otvoriti `chrome://extensions` u pregledniku utemeljenom na Chromiumu.
2. Uključiti **Developer mode** (gore desno).
3. Kliknuti **Load unpacked** i odabrati mapu projekta.

Proširenje se pojavljuje u traci. Prvo prikupljanje pokreće se ubrzo nakon instalacije, a zatim periodički u pozadini.

## Tehnologije

- **Manifest V3** - norma za proširenja preglednika (servisni proces, model dozvola).
- **JavaScript (ES moduli)** - bez okvira i bez prevođenja.
- **Dexie.js** - sloj nad IndexedDB za pohranu unutar preglednika.
- **DOMParser** (preko skrivenog dokumenta) - razrješavanje HTML-a pri ekstrakciji.

## Dozvole

Proširenje traži dozvole prema načelu najmanjih ovlasti:

- `storage`, `unlimitedStorage` - pohrana događanja u pregledniku.
- `alarms` - periodičko pokretanje prikupljanja.
- `notifications` - obavijesti o nastupima praćenih izvođača i promjenama na stranicama.
- `offscreen` - skriveni dokument za razrješavanje HTML-a.
- pristup poslužiteljima ugrađenih izvora navodi se zasebno; pristup korisnikovim vlastitim stranicama traži se **tek pri njihovu dodavanju**, pojedinačno za svaku adresu.

## Napomena

Ovo je istraživački, osobni alat izrađen za diplomski rad. Ekstrakcija iz HTML-a ovisi o ustroju pojedinih stranica, pa se prikupljanje s izvora bez službenog sučelja može promijeniti ako te stranice promijene svoj oblik.
