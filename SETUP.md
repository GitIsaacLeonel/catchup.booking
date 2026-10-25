# Catch-up booking: setup guide

## How it works

1. A guest opens your booking page and enters name, email, an optional topic and how they would like to meet (online, in person, no preference). For in person they can suggest an area. **The guest does not pick a time.**
2. The app finds the **next free hour**: inside your working hours, free in Google Calendar (with a 15 minute buffer), after the minimum notice, and on a day where you have not reached your limit of catch-ups. Every catch-up is 1 hour. A yellow **[PENDING]** hold appears in your Google Calendar so nobody else can take it, and the guest sees the reserved time and gets a "request received" email.
3. You get an email with the buttons **Confirm online**, **Confirm in person** and **Decline**. Each one opens your private manage page. Nothing happens until you press a button there, so link previews cannot trigger anything.
4. On the manage page you:
   - choose **Online** (a Google Meet link is created) or **In person** and enter the location (your favourite places and the guest's suggestion are quick picks)
   - keep the reserved time, or move it to another free hour or any time you type
   - optionally add a note to the guest (for example "I reserved a table under my name")
   - press **Confirm and send invite**
5. The hold becomes the real event (green) with the guest as attendee. Google sends the invite, and the guest also gets a confirmation email with a **Join with Google Meet** or **Open in Google Maps** button.
6. **Changing later:** open the same manage page (from the request email or the admin page), change time, format, place or note, and press **Save changes and notify guest**. The guest gets an "Updated" email with the old values crossed out, and the invite is updated.
7. **Cancelling:** on the manage page press **Cancel catch-up**, with an optional message. The event is removed, Google sends the cancellation and the guest gets an email with a link to pick a new time.
8. Unanswered requests are released after 48 hours, or 1 hour before the slot starts.
9. If you move or delete the event directly in Google Calendar, the tool picks it up within an hour.

## Setup (about 10 minutes)

1. Go to **script.google.com** with the Google account whose calendar should be used. Click **New project** and name it "Catch-up booking".
2. Click the gear icon (**Project Settings**) and tick **Show "appsscript.json" manifest file in editor**. Check that the time zone is Europe/Berlin.
3. Back in the **Editor**:
   - Replace the content of `appsscript.json` with the file from this folder.
   - Replace the content of `Code.gs` with the file from this folder.
   - Click **+ > HTML**, name it `Booking` (without .html) and paste `Booking.html`.
   - Click **+ > HTML**, name it `Manage` and paste `Manage.html`.
   - Click **+ > HTML**, name it `Admin` and paste `Admin.html`.
4. You do not need to edit any code. You change all settings later on the admin page. The `DEFAULTS` block at the top of `Code.gs` is only where they start.
5. Select the function **testSetup** in the toolbar and click **Run**. Google asks for permissions (calendar and email). Click **Advanced > Go to Catch-up booking (unsafe)**. This warning is normal for your own scripts. The log should show the next free time a guest would get.
6. Click **Deploy > New deployment**, type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL**. This is your booking link.
7. Select **installTriggers** and click **Run** once. This sets up the hourly job (expiry, calendar sync, data deletion).
8. Select **setupAdmin** and click **Run**. The log shows your private admin link. Bookmark it and keep it to yourself.
9. Open the admin link and paste the web app URL into **Web app URL**. This makes sure links in emails always point to the live version. Check your working hours, add your favourite places and click **Save settings**.
10. Click **Run check** at the bottom. Then open the booking link in a private browser window and book a test catch-up with another email address.

**Updating later:** after changing code, use **Deploy > Manage deployments > Edit (pencil) > Version: New version**. This keeps the same URL, and your saved settings stay as they are.

## The admin page

Your private link looks like `https://script.google.com/macros/s/.../exec?action=admin&key=...`. Without the right key the normal booking page is shown, so nobody can tell an admin page exists.

What you can do there:

- See **open and upcoming catch-ups** and open each one to review, change or cancel it
- **Pause bookings** with one switch, and set the message guests see while paused
- **Calendars:** pick the main Google calendar and add other Google calendars whose busy times should count
- **Availability:** working hours per weekday, buffer, minimum notice, days ahead, catch-ups per day, time zone (the length is always 1 hour)
- **Favourite places:** quick picks for in-person catch-ups
- **Requests and privacy:** expiry, open requests per guest, requests per hour, how long guest data is kept, privacy notice text
- **Delete a guest's data** when someone asks for it
- **Health check:** calendar access, hourly job, email quota, storage use, the time the next guest would get

**If the admin link ever leaks:** run **rotateAdminKey** in the editor. The old link stops working right away and the log shows the new one.

**If a manage link leaks:** it only gives access to that one catch-up. Cancel the catch-up and ask the guest to book again.

## Good to know

- **Events marked "Free"** and events you have declined do not block slots. All-day events block only when they are set to "Busy".
- **Pending and confirmed catch-ups always block their slot**, so you cannot be double booked by your own requests.
- **Earliest first:** start times are checked every 30 minutes, so the next free hour can start at 9:00 or 9:30. If no hour is free within the bookable days, the guest sees a message to try again later.
- **When you move a catch-up** you see your free hours (its own current time counts as free). You can also type any time. If you are busy then, the page asks you to tick **Book anyway**.
- **Emails** go out from your Gmail. A free Gmail account can send about 100 script emails per day. Each catch-up uses 2 to 4 emails.
- **Spam protection:** a hidden field catches bots, each email address can have at most 2 open requests, and there is a limit of new requests per hour for all guests together.
- **Overview of all records:** run **listRequests** in the editor and look at the log.
- **Google Workspace accounts:** if "Anyone" is not available under access, your Workspace admin has blocked public web apps. A personal Gmail account works without this restriction.
