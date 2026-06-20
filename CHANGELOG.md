# Changelog – Schüttelstraße Disaster Management

Alle bedeutenden Änderungen am Echtzeit-Gefahrenwarnsystem für
**Schüttelstraße 79 & 81, 1020 Wien**.

Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung folgt [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.16.1] – 2026-06-21

### Fixed
- **Stromversorgung – Over-Alerting behoben**: Roter Alarm wird jetzt nur noch
  ausgelöst, wenn der Stromausfall den **2. Bezirk (Leopoldstadt / 1020 Wien)**
  betrifft. Störungen im restlichen Wiener Netze-Versorgungsgebiet (z. B. NÖ,
  andere Bezirke) generieren nur noch eine gelbe **Warnung**.
- District-2-Erkennung via Keyword-Scan auf dem gescrapten HTML der Wiener
  Netze-Statusseite (`Leopoldstadt`, `1020`, Straßennamen im 2. Bezirk etc.).
- Neues Feld `affectsDistrict2: boolean` im JSON-Output des `power`-Hazards.

---

## [1.16.0] – 2026-06-05

### Added
- **AI URL-Optimierer**: Neues GitHub Actions Workflow (`url-optimizer.yml`) mit
  `aiOptimizeUrls.js` – KI-gestütztes Überprüfen und Optimieren von Quell-URLs
  aller Hazard-Karten.
- **Link Guardian** ausgebaut: Self-Healing-Mechanismus für defekte URLs.
- Weitere Robustheitsverbesserungen im Datenabruf.

---

## [1.15.6] – 2026-06-05

### Fixed
- Diverse Stabilitätsfixes (Patch-Serie 1.15.3 → 1.15.6 am selben Tag).

---

## [1.15.5] – 2026-06-05

### Fixed
- Weitere Korrekturen in der Datenabruf-Pipeline.

---

## [1.15.4] – 2026-06-05

### Fixed
- Fehlerbehandlung und Fallback-Logik verbessert.

---

## [1.15.3] – 2026-06-05

### Fixed
- Kleinere Korrekturen nach 1.15.2.

---

## [1.15.2] – 2026-06-04

### Fixed
- Stabilitätsfixes und Fehlerkorrekturen.

---

## [1.15.1] – 2026-06-04

### Fixed
- Frontend-Version und Service Worker Cache synchronisiert.

---

## [1.15.0] – 2026-06-04

### Added
- Größere Feature-Erweiterung (Minor Release).
- Verbesserungen in der Datenaggregation und im Dashboard.

---

## [1.10.4] – 2026-06-03

### Fixed / Style
- Gesamtstatus und Footer auf kleinen Bildschirmen scrollbar gemacht.

---

## [1.10.3] – 2026-06-03

### Changed
- Service Worker auf **Network-First**-Strategie für HTML umgestellt
  (frischere Daten bei bestehender Verbindung).

---

## [1.10.2] – 2026-06-03

### Fixed
- Erzwingt Single-Column-Layout auf Smartphones.

---

## [1.10.1] – 2026-06-03

### Added
- `localStorage`-Cache und Offline-Fallback beim Dashboard-Ladevorgang.

---

## [1.10.0] – 2026-06-03

### Added
- Minor Release – umfangreichere Überarbeitungen des Datenabruf- und
  Anzeigesystems.

---

## [1.9.1] – 2026-06-03

### Fixed
- Patch nach 1.9.0.

---

## [1.8.0] – 2026-06-02

### Added
- Version-Badge im Frontend.
- Service Worker Cache auf v25 angehoben.

---

## [1.7.1] – 2026-03-08

### Fixed
- Versionsnummer im Frontend korrigiert.

---

## [1.7.0] – 2026-03-03

### Added / Changed
- Größere Überarbeitung (Minor Release).

---

## [1.6.7] – 2026-02-25

### Changed
- Luftqualitätsquelle auf **IQAir** gewechselt (präzisere AQI-Daten).

---

## [1.6.6] – 2026-02-25

### Changed
- **Taktische Zufahrt**: Karte auf Wiener Linien API + Google Maps umgebaut.

---

## [1.6.5] – 2026-02-25

### Fixed
- Adaptives Karten-Layout optimiert.

---

## [1.6.4] – 2026-02-25

### Fixed
- `undefined`-Werte in Hazard-Karten behoben.

---

## [1.6.3] – 2026-02-25

### Fixed
- UI-Rendering-Fehler behoben.

---

## [1.6.2] – 2026-02-25

### Added
- **Luftfeuchtigkeit** zur Wind-Karte hinzugefügt.

---

## [1.6.1] – 2026-02-25

### Added
- **Luftdruck** und Trend zur Unwetterwarnungen-Karte hinzugefügt.

---

## [1.6.0] – 2026-02-24

### Added
- Karten-Grid auf **zeilenweise Sortierung** umgestellt.
- **Taktische Zufahrt** (Verkehr 1020 Leopoldstadt) als neue Hazard-Karte.
- **Blackout-Frühwarnung** (Netzfrequenz-Monitoring) integriert.
- **Trinkwasser- und Gasstatus** als neue Indikatoren.

---

## [1.5.9] – 2026-02-24

### Changed
- Benutzerdefinierte Karten-Sortierreihenfolge implementiert.

---

## [1.5.8] – 2026-02-24

### Style
- Unwetterwarnungen-Icon auf Custom SVG aktualisiert.

---

## [1.5.7] – 2026-02-24

### Fixed
- `ReferenceError` in `fetchData.js` behoben.

---

## [1.5.6] – 2026-02-24

### Added
- **UV-Index** in die Hitze-Karte integriert (NOAA-Daten via currentuvindex.com).

---

## [1.5.5] – 2026-02-24

### Changed
- Hagel- und Gewitterwarnungen verfeinert.

---

## [1.5.4] – 2026-02-24

### Changed
- **Weltraumwetter**: Kp-Index als primärer Indikator (NOAA SWPC).

---

## [1.5.3] – 2026-02-24

### Style
- Single-Screen-Layout-Optimierung, kompakter Header, horizontale
  Grid-Erweiterung auf bis zu 5 Spalten (Desktop).

---

## [1.5.2] – 2026-02-24

### Style
- Typografie-Verfeinerungen (Titel / Untertitel).

---

## [1.5.1] – 2026-02-24

### Added
- **Versionsnummern-Anzeige** im Dashboard.
- Auto-Update-Polling eingeführt.
- Versionierungsrichtlinie (SemVer) festgelegt.

---

## [1.5.0] – 2026-02-24 *(implizit)*

### Added
- **Gewitterwarnungen** via GeoSphere Austria Warn-API.
- **UWZ-Unwetterwarnungen** (Wien & Leopoldstadt) + Glatteis-Monitoring.
- **Schneefall / Winterdienst** (GeoSphere SNOWGRID).
- **Hochwasser-Trend-Pfeil** auf der Flood-Karte.
- HTML-Scraping-Fallback für AT-Alert.
- Mobile Darstellung drastisch verbessert (Schriftgrößen, Kontrast).
- PWA-Update-Erzwingung via Cache-Bump.

---

## [1.4.0] – 2026-02-23 *(implizit)*

### Added
- **Stromausfall-Monitoring** in Echtzeit (Wiener Netze Statusseite).
- **Weltraumwetter** (NOAA Space Weather Prediction Center).
- **NASA FIRMS** Satelliten-Hotspot-Monitoring aktiviert.
- **Waldbrandgefahr** (WBI-Index + NASA FIRMS).
- **AT-Alert** Offizielles österreichisches Warnsystem integriert.
- **Pandemie / Seuchengefahr** (WHO Disease Outbreak News + MedUni Wien).
- **Erdbeben-Monitoring** (ZAMG/EMSC FDSN).
- **Luftqualität / Feinstaub** (Wien.gv.at Luftgütebericht).
- PWA Install-Button für Mobile.
- Severity-Sortierung der Karten (höchste Gefahr oben).
- Alle Karten mit Quell-Links ausgestattet.

---

## [1.3.0] – 2026-02-23 *(implizit)*

### Added
- **Netlify Function** für Live-Datenabruf bei jedem Seitenaufruf.
- 5-Minuten-Update-Intervall (GitHub Actions Cron).
- SVG-Favicon mit Dark-Mode-Optimierung.
- Lokale JSON-Datenstrategie (statt GitHub Raw) für schnellere Updates.

---

## [1.2.0] – 2026-02-22 *(implizit)*

### Added
- **Radioaktivitäts-Monitoring** (Strahlenschutz.gv.at, Station AT2002 Wien).
- **Hochwasser**: Auf danubealert.com / Schwedenbrücke Pegel (cm) umgestellt.
- EFAS & ERCC als weiterführende Hochwasser-Ressourcen.
- Cache-Busting Headers via `netlify.toml`.
- Favicon für Disaster Management.

---

## [1.1.0] – 2026-02-22 *(implizit)*

### Added
- **Hochwasser**: Open-Meteo GloFAS Echtzeit-Flussdaten (erster API-Abruf).
- `.gitignore` eingerichtet, `node_modules` aus Tracking entfernt.

---

## [1.0.0] – 2026-02-22

### Added
- **Initiales MVP**: `fetchData.js`, Dashboard (`index.html`), GitHub Actions
  Workflow für automatischen Datenabruf alle 5 Minuten.
- Gefahrenindikatoren: Hitze, Wind, Starkregen, Hochwasser (GeoSphere Austria).
- Grundlegendes Dark-Mode Dashboard.
- Netlify Deployment.

---

*Generiert und gepflegt durch Antigravity AI – letzte Aktualisierung: 2026-06-21*
