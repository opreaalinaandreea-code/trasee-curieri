# Trasee Curieri

Aplicație web pentru planificarea automată a traseelor de livrare ale curierilor, cu repartizare optimizată a adreselor, calcul de intervale orare de livrare și export Excel.

Construită pentru livrări în **București, Ilfov și zona limitrofă**.

## Funcționalități

- **Import adrese** din CSV/XLSX (export WooCommerce sau similar), cu mapare automată a coloanelor (nume, telefon, oraș, stradă, număr, detalii, metodă de plată, sumă, notă client)
- **Geocodare** prin OpenStreetMap/Nominatim, cu:
  - bază persistentă de adrese verificate (salvată local în browser) — adresele corectate manual sau geocodate cu precizie ridicată sunt reținute și reutilizate instant la viitoare importuri identice, fără cerere nouă către Nominatim
  - normalizare automată a prescurtărilor românești de stradă (str/sos/bd/cal → Strada/Șoseaua/Bulevardul/Calea)
  - cascadă de variante de interogare pentru adrese incomplete
  - scor de încredere (precis / aproximativ / incert / din bază verificată) vizibil pe fiecare adresă
  - validare geografică strictă — orice rezultat în afara zonei București/Ilfov + marjă e respins automat, cu excepție manuală posibilă per adresă (din formularul de editare) pentru cazuri excepționale
- **Curieri** configurabili individual: punct de plecare, punct de finalizare (poate diferi de plecare), oră de plecare, oră-limită opțională, cu buton de confirmare/validare per curier
- **Repartizare automată** a adreselor pe curieri, în 2 pași:
  1. clustering geografic compact (k-means cu capacitate constrânsă) — fiecare curier primește o zonă coerentă, nu adrese izolate alocate doar pe distanța față de punctul de start
  2. rafinare pe timp total de traseu (buffer de 2h între curieri)
- **Optimizare rută** per curier via OSRM (timp/distanță reală pe drum, nu linie dreaptă)
- **Intervale de livrare** calculate automat: ora estimată de sosire + buffer de predare, rotunjită la fereastră fixă de 2 ore
- **Editare manuală**: corectare adresă, realocare manuală către alt curier (cu blocare împotriva rescrierii la următoarea repartizare automată), ajustare poziție pin direct pe hartă (drag & drop)
- **Hartă interactivă** (Leaflet) cu trasee colorate per curier, marcaje numerotate în ordinea de livrare
- **Export Excel (.xlsx)** cu structură fixă: Curier, Interval Livrare, Nr. Comandă, nume, telefon, adresă, detalii, metodă de plată, sumă, notă client

## Utilizare

Aplicația e complet client-side — nu necesită server sau build step.

```bash
# Deschide direct în browser
open index.html

# sau servește local
python3 -m http.server 8000
```

Apoi navighează la `http://localhost:8000`.

## Stack tehnic

- HTML/CSS/JavaScript vanilla (fără framework, fără build)
- [Leaflet](https://leafletjs.com/) — hartă interactivă
- [PapaParse](https://www.papaparse.com/) — parsare CSV
- [SheetJS (xlsx)](https://sheetjs.com/) — citire/scriere fișiere Excel
- [Nominatim](https://nominatim.openstreetmap.org/) — geocodare (OpenStreetMap, gratuit)
- [OSRM](http://project-osrm.org/) — calcul rute și optimizare ordine livrări (demo server public, gratuit)

Toate serviciile externe sunt gratuite, fără cheie API necesară. Respectă limitele de utilizare ale Nominatim (~1 cerere/secundă).

## Structură

```
.
├── index.html   # UI, stiluri, structură pagină
└── app.js       # toată logica aplicației (state, geocodare, rutare, randare)
```

## Zona de operare

Validarea geografică e fixată pe București + Ilfov + ~25-30km marjă. Pentru a o ajusta, modifică `SERVICE_AREA_BOUNDS` din `app.js`.

## Limitări cunoscute

- Geocodarea gratuită (Nominatim) nu garantează precizie 100% pentru toate adresele — adresele cu scor de încredere scăzut trebuie verificate/ajustate manual pe hartă
- Baza de adrese verificate se salvează în `localStorage`, local pe acest calculator/browser — nu se sincronizează automat între dispozitive sau calculatoare diferite
- OSRM (server demo public) poate avea limite de rată sub sarcină mare; pentru volume foarte mari, ar fi nevoie de o instanță proprie
- Fără persistență pentru restul datelor (curieri, adrese, trasee) — acestea se pierd la reîncărcarea paginii (nu există backend/bază de date)

## Licență

MIT
