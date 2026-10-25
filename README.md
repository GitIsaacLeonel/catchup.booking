# Catch-up Booking

A booking page for catch-ups, built on Google Apps Script. It is a sibling of `slot.booking`.

People fill in a short form. They do not pick a time: the app finds the next free hour in your Google Calendar and holds it right away. Every catch-up is 1 hour. You then confirm on a private page and decide there whether you meet **online (Google Meet)** or **in person** at a place you type in. After you confirm, the guest gets a confirmation email and a calendar invite, and the slot is blocked in your calendar. You can change the time, the format or the place later, or cancel, and the guest is told about every change.

## Features

- Booking form without a time picker: name, email, topic, preferred format (online, in person, no preference), optional preferred area, privacy consent
- The next free 1 hour slot is found automatically from Google Calendar (plus optional extra Google calendars), inside your working hours, with buffer, minimum notice and a limit per day
- A pending hold in your calendar until you decide. It is released automatically after a timeout.
- Confirm page: online with an automatic Meet link, or in person with a location (your saved places and the guest's suggestion are quick picks), plus an optional note to the guest
- **Change a booking at any time:** new time (from your free hours or any time you type), online or in person, new place, new note. The guest gets an "Updated" email that shows the old values crossed out, and Google updates the invite.
- Cancel or decline with an optional message
- Changes you make directly in Google Calendar (moving or deleting the event) are picked up every hour
- Hidden admin page: settings, favourite places, upcoming catch-ups, deleting a guest's data, health check
- No server to host: runs free on your Google account

## Files

| File | Purpose |
|---|---|
| `Code.gs` | Server logic (JavaScript, Apps Script V8) |
| `Booking.html` | Public booking form |
| `Manage.html` | Your private page to confirm, change, decline or cancel one catch-up |
| `Admin.html` | Hidden admin page |
| `appsscript.json` | Manifest (Calendar advanced service, web app settings) |
| `SETUP.md` | Step by step setup guide |
| `REQUIREMENTS.md` | Functional and non-functional requirements, and how each one is met |

## Setup

See [SETUP.md](SETUP.md).

No credentials are stored in this repository.
