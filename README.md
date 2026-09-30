# OV Dichtbij – eerste prototype

Dit prototype doet:
- GPS-locatie opvragen
- 3 dichtstbijzijnde haltes tonen
- dienstregeling ophalen uit de openbare Nederlandse GTFS-data van OVapi via de bestaande OVNu-dataset
- waar mogelijk realtime bus/tram/metro/ferry-vertrektijden ophalen via OVapi, met een haltecode die via OpenStreetMap wordt gevonden
- automatisch terugvallen op de dienstregeling als realtime niet beschikbaar is

## Belangrijk
Voor een productie-app zou ik de data niet rechtstreeks vanuit de browser combineren. Dan bouwen we een kleine backend/cache en voegen we treinrealtime toe via de officiële NS Reisinformatie API. De 9292 Vertrektijden API is een alternatief voor één landelijke bron, maar daarvoor is een commerciële aansluiting nodig.

## Snel testen
Open `index.html` vanaf een HTTPS-host. Geolocation werkt in moderne browsers alleen betrouwbaar op HTTPS (of localhost).

Voor iPhone is GitHub Pages een eenvoudige testomgeving:
1. Maak een GitHub-repository.
2. Upload deze bestanden.
3. Zet Pages aan via Settings → Pages → GitHub Actions/branch.
4. Open de Pages-url op de iPhone.
5. Geef locatie toestemming.

## Volgende versie
- automatische refresh iedere 30 seconden
- loopafstand naar halte i.p.v. alleen hemelsbrede afstand
- vertraging expliciet tonen
- uitval/werkzaamheden
- treinrealtime
- kaart
- favorieten
- PWA-installatie op beginscherm
