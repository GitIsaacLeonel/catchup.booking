# Catch-up booking: requirements

Owner = you (the calendar owner). Guest = the person booking.

## Functional requirements

| ID | Requirement | Where |
|---|---|---|
| F1 | A guest can request a catch-up with a form: name, email, optional topic, preferred format (online, in person, no preference), optional preferred area, privacy consent. The guest does not choose a time. | `Booking.html`, `submitBooking` |
| F2 | Every catch-up lasts exactly 1 hour. | `DURATION_MINUTES` |
| F3 | The app picks the next free hour: free in the main Google calendar and in any extra calendars, inside working hours, with buffer, minimum notice, days ahead and a daily limit. It places a pending hold right away, so the time cannot be taken twice, and shows the reserved time to the guest. | `submitBooking`, `getSlots_`, `getBusy_` |
| F4 | The owner is notified by email and confirms on a private manage page. | `notifyOwner_`, `Manage.html` |
| F5 | When confirming, the owner decides: **online** (a Google Meet link is created) or **in person** at a location the owner enters. Saved favourite places and the guest's suggestion are offered as quick picks. The owner can add a note to the guest. | `saveBooking` |
| F6 | On confirmation the hold becomes the real event with the guest as attendee, Google sends the invite, and the guest gets a confirmation email with the details and a Join or Maps button. | `saveBooking`, `detailRows_`, `actionButtons_` |
| F7 | Before confirming, and at any time after, the owner can change the time (another free hour or any time), format, location and note. The guest gets an "Updated" email showing old and new values, and the invite is updated. | `saveBooking`, `ownerSlots` |
| F8 | The owner can decline a request or cancel a confirmed catch-up with an optional message. The calendar entry is removed and the guest is notified with a link to book again. | `cancelBooking` |
| F9 | Unanswered requests are released automatically after a set time or 1 hour before the start. | `hourlyJob` |
| F10 | Moving or deleting the event directly in Google Calendar is reflected in the tool. | `syncFromCalendar_` |
| F11 | The owner manages all settings, sees open and upcoming catch-ups and can pause bookings on a hidden admin page. | `Admin.html`, `adminSave` |

## Non-functional requirements

### Security

| ID | Requirement | How it is met |
|---|---|---|
| S1 | Only the owner can confirm, change or cancel a catch-up. | Each catch-up has a random 36 character token that only appears in the owner's email and admin page. The guest never sees it. The event description the guest can read never contains the manage link. |
| S2 | The admin page cannot be found or guessed. | A 64 character secret key in the URL. Without it the normal booking page is shown. Wrong keys are slowed down by 1.5 seconds. A leaked key is replaced with `rotateAdminKey`. |
| S3 | No action happens by opening a link. | Email links only open a page. Every change needs a button press, so mail scanners and link previews cannot trigger anything. |
| S4 | No injection through guest input. | All input is trimmed and length limited on the server. All output in emails and pages is HTML escaped. Data passed into templates is JSON encoded with `<`, `>` and `&` escaped. |
| S5 | Protection against bots and abuse. | Hidden honeypot field, at most 2 open requests per email address, a limit of new requests per hour for all guests together. |
| S6 | No secrets in the code or repository. | The admin key and URL live only in the script properties. The app needs no third-party credentials. |
| S7 | Least privilege. | The script only uses Google Calendar and Gmail sending. It makes no external HTTP calls. |

### Privacy (GDPR)

| ID | Requirement | How it is met |
|---|---|---|
| P1 | Data minimisation. | Only name, email, topic, format preference, preferred area and time zone are collected. |
| P2 | Informed consent. | The guest must tick a privacy notice (text editable on the admin page) before sending. |
| P3 | Storage limitation. | Records are deleted automatically a set number of days after the catch-up (default 30). Declined, cancelled and expired records are deleted after the same period. |
| P4 | Right to erasure. | The admin page deletes every record of an email address in one step. |
| P5 | No personal data in logs. | Log lines contain only the record ID, status and version, never names, emails or messages. |
| P6 | Data stays in the owner's Google account. | Records live in the script properties of the owner's own Apps Script project. No third-party processor. |

### Reliability and data consistency

| ID | Requirement | How it is met |
|---|---|---|
| R1 | No double booking, even if two guests send at the same moment. | The next free hour is searched and the hold created under one script lock, so the second guest gets the following free hour. |
| R2 | No lost updates when the owner has the manage page open twice (or in two tabs). | Every record has a version number. A save with an old version is rejected with "changed in the meantime, please reload". |
| R3 | No double actions from double clicks. | Buttons are disabled while a request runs. The server only acts on records in a valid status. |
| R4 | Fail safe availability. | If a calendar cannot be read, the request fails with an error instead of reserving a time that might be busy. If no hour is free, the guest is told to try again later. |
| R5 | One faulty record never stops the background job. | `hourlyJob` handles each record on its own and logs errors. |
| R6 | The tool and the calendar stay in sync. | Hourly sync of time changes and deletions made in Google Calendar. If the event was deleted before you change a catch-up, a new event is created. |
| R7 | Self-healing holds. | Unanswered holds are released automatically so slots are never blocked forever. |

### Performance and capacity

| ID | Requirement | Target |
|---|---|---|
| C1 | Sending a request (finding the next free hour and reserving it). | Normally 3 to 6 seconds, with one calendar read for the whole range. |
| C2 | Confirming or changing a catch-up. | Under 10 seconds, including creating the Meet link. |
| C3 | Volume. | Built for personal use: up to about 100 catch-ups a month. Storage use is shown in the health check, and a warning appears above 80% of the 500 KB limit. |
| C4 | Email quota. | 2 to 4 emails per catch-up, within the 100 emails a day of a free Gmail account. The health check warns when fewer than 10 are left. |

### Usability and accessibility

| ID | Requirement | How it is met |
|---|---|---|
| U1 | Guests see times in their own time zone, the owner in theirs. | The browser time zone is detected and stored with the request. Emails use the guest's time zone. |
| U2 | Works on phones. | Responsive layouts, viewport meta tag, layouts switch to one column below 520 px. |
| U3 | Accessible (WCAG 2.1 AA as the target). | Every field has a label, radio groups have a legend, status and error messages use `aria-live` or `role="alert"`, time buttons on the manage page report `aria-pressed`, there is a visible focus ring, and text contrast is at least 4.5:1. Everything works with the keyboard. |
| U4 | Clear feedback. | Each action shows a status message. Errors explain what to do (for example "Tick Book anyway to keep this time"). |
| U5 | The owner can decide quickly. | The request email has one-click entry points (online, in person, decline). The guest's preference is preselected. |

### Maintainability and operations

| ID | Requirement | How it is met |
|---|---|---|
| M1 | No server to run, no cost. | Google Apps Script on the owner's account. |
| M2 | Change settings without touching code. | Every setting is on the admin page and validated on save. |
| M3 | Updates keep the URL and the data. | New deployment versions use the same URL. Settings and records live in script properties. |
| M4 | Observability. | Structured JSON logs in Cloud Logging (`console.info`), uncaught errors via Stackdriver exception logging, a health check on the admin page, and a history of up to 15 changes on each catch-up. |
| M5 | Same structure as `slot.booking`. | Same file layout, helpers and coding style, so both are maintained the same way. |

## Out of scope (possible next steps)

- Guest self-service to cancel or move a booking
- Microsoft Teams, Zoom or Outlook availability (available in `slot.booking`)
- Reminder emails before the catch-up (Google Calendar reminders already cover the invite)
- More than about 100 catch-ups a month. That would need a Google Sheet or a database instead of script properties.
