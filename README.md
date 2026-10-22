# Tabletop

A same-room homebrew D&D table: a shared map on the TV, a DM control screen, and players on their phones.

## Setup

You need [Node.js](https://nodejs.org) (version 18 or newer). On Windows, double-click `start.bat`: the first time, it installs what it needs. On other systems, run `npm install` once, then `npm start`.

## Starting a game

1. Double-click `start.bat`. The window shows three addresses, the DM PIN and the room code.
2. **TV:** open `http://localhost:3000/tv` on the PC plugged into the TV (press F11 for fullscreen).
3. **DM:** open `/dm` on your laptop or tablet and enter the PIN. From another device, use the PC's address, e.g. `http://192.168.x.x:3000/dm`.
4. **Players:** scan the QR code on the TV, or type the address shown, then enter the room code and a character name.

Everyone has to be on the same Wi-Fi. If phones can't connect, Windows Firewall is probably blocking Node.js. Allow it on private networks when Windows asks, or under Windows Defender Firewall > Allow an app.

## What's where

- **TV:** the map, tokens, enemy health bars (no numbers), the party bar (exact HP and status effects), the scene text, the join QR and roll popups. It can follow the DM's zoom.
- **DM:** drag tokens, answer rolls, damage and heal, status effects, each player's die and whether they use real dice, enemies and NPCs (with colours, relationships, and turning NPCs into enemies), the campaign's character attributes, and maps.
- **Phone:** a small map, your character sheet (attributes, inventory, backstory, notes), people you've met with private notes, the roll log, and the Action button.

## Maps

- Upload an image, or make a **blank map** (a colour and a size, like 60 × 40 ft).
- Set a map's real width and tokens are drawn true to scale (5 ft per token). The grid is graph paper, labelled in feet or metres.
- Draw **walls**, **windows**, boxes, circles and text with the toolbar on the DM's map. Undo, Redo and Reset are there too.
- Four or more joined walls make a **room**. Outside rooms is dark on the TV and phones, except what players can see: by day, anything in their line of sight (windows let them see out); at night, only within their light. Enemies in the dark are hidden.

## Campaigns and characters

The DM can keep several campaigns and plays one at a time. After the PIN, the DM picks a campaign (or creates one), and can switch later with the **Campaigns** button.

Players enter the room code, then pick one of the campaign's characters or make a new one. No accounts are needed: the phone remembers its character and rejoins by itself. Characters the DM marks as dead can't be picked.

Everything saves as you go:

- `data/campaigns/<id>/campaign.json` holds maps, enemies, NPCs and the roll log
- `data/campaigns/<id>/characters/<id>/` is one folder per character; the DM can move a character to another campaign from the Campaigns screen (open **⋯** on a campaign)
- `data/uploads/` holds the map images

Back up the `data` folder to keep your campaigns. Saves from before campaigns existed were moved into campaigns automatically; the originals are kept in `data/saves-before-campaigns/`.

The DM PIN is in `data/dm-pin.txt`. Delete that file to get a new PIN.
