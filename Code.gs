/**
 * Catch-up booking
 * ----------------
 * Guest fills in the form -> the next free 1 hour slot is found and a [PENDING] hold is placed in your Google Calendar
 * -> you get an email and decide on the manage page: online (Google Meet) or in person at a location you enter
 * -> on confirmation the hold becomes the real event, Google sends the invite and the guest gets a confirmation email.
 * You can change time, format and location or cancel later from the same manage page; the guest is notified each time.
 *
 * Availability = free in the main Google calendar (plus optional extra Google calendars),
 * inside your working hours, with buffer, minimum notice and a daily limit.
 */

const DEFAULTS = {
  OWNER_NAME: 'Isaac Touka Tchoumkeu',
  OWNER_EMAIL: '',                 // empty = the Google account that deploys the script
  CALENDAR_ID: 'primary',
  TIMEZONE: 'Europe/Berlin',
  BUFFER_MINUTES: 15,             // free time required before and after each catch-up
  MIN_NOTICE_HOURS: 24,            // earliest bookable slot from now
  DAYS_AHEAD: 28,                  // how far ahead guests can book (max 60)
  MAX_PER_DAY: 3,                  // catch-ups per day from this tool, 0 = no limit
  // Working hours per weekday, 1 = Monday ... 7 = Sunday, in TIMEZONE
  WORKING_HOURS: {
    1: [['09:00', '12:00'], ['13:00', '18:00']],
    2: [['09:00', '12:00'], ['13:00', '18:00']],
    3: [['09:00', '12:00'], ['13:00', '18:00']],
    4: [['09:00', '12:00'], ['13:00', '18:00']],
    5: [['09:00', '12:00'], ['13:00', '16:00']],
  },
  PENDING_EXPIRY_HOURS: 48,        // unanswered requests are released after this
  MAX_PENDING_PER_EMAIL: 2,        // open requests per guest
  MAX_REQUESTS_PER_HOUR: 20,       // all guests together, protects your email quota
  RETENTION_DAYS: 30,              // guest data is deleted this many days after the catch-up
  MEETING_TITLE: 'Catch-up with {name}',
  BOOKING_ENABLED: true,           // false = booking page shows PAUSED_MESSAGE
  PAUSED_MESSAGE: 'Bookings are paused at the moment. Please check back later.',
  EXTRA_BUSY_CALENDARS: [],        // more Google calendar IDs whose busy times count
  LOCATIONS: [],                   // favourite places offered as quick picks when you confirm in person
  PRIVACY_NOTICE: 'Your name, email and message are only used to arrange this catch-up and are deleted {days} days after it.',
};

const DURATION_MINUTES = 60;      // every catch-up is 1 hour
const ACTIVE_ = ['pending', 'confirmed'];
const HISTORY_MAX_ = 15;

/**
 * Effective settings = DEFAULTS above, overridden by what you save on the admin page.
 */
let SETTINGS_CACHE_ = null;
function C() {
  if (!SETTINGS_CACHE_) {
    let saved = {};
    try { saved = JSON.parse(props_().getProperty('SETTINGS') || '{}'); } catch (err) { saved = {}; }
    SETTINGS_CACHE_ = Object.assign({}, DEFAULTS, saved);
  }
  return SETTINGS_CACHE_;
}

function calId_(req) { return (req && req.calendarId) || C().CALENDAR_ID; }
function privacyText_() { return C().PRIVACY_NOTICE.replace('{days}', C().RETENTION_DAYS); }

/* ============================ Web entry ============================ */

function doGet(e) {
  const p = (e && e.parameter) || {};

  // Hidden admin page: only opens with the right key, otherwise the normal booking page is shown
  if (p.action === 'admin' && adminKeyOk_(p.key)) {
    const t = HtmlService.createTemplateFromFile('Admin');
    t.data = safeJson_({ key: p.key });
    return page_(t, 'Catch-up admin');
  }

  if (p.action === 'manage') {
    const req = getRequest_(p.id);
    if (!req || !tokenOk_(req, p.token)) {
      return simplePage_('Link not valid', 'This catch-up was not found or the link is incomplete.');
    }
    const t = HtmlService.createTemplateFromFile('Manage');
    t.data = safeJson_(Object.assign(manageView_(req), {
      preselect: ['online', 'inperson', 'decline'].indexOf(p.do) >= 0 ? p.do : '',
    }));
    return page_(t, 'Manage catch-up');
  }

  const t = HtmlService.createTemplateFromFile('Booking');
  t.data = safeJson_({
    ownerName: C().OWNER_NAME, minutes: DURATION_MINUTES,
    paused: !C().BOOKING_ENABLED, pausedMessage: C().PAUSED_MESSAGE,
    privacy: privacyText_(),
  });
  return page_(t, 'Book a catch-up with ' + C().OWNER_NAME);
}

function page_(t, title) {
  return t.evaluate().setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ============================ Called from the booking page ============================ */

/** The guest does not pick a time: the next free slot is reserved and you confirm or move it. */
function submitBooking(form) {
  form = form || {};
  if (form.website) return { ok: true }; // honeypot: bots fill hidden fields
  if (!C().BOOKING_ENABLED) throw new Error(C().PAUSED_MESSAGE);

  const name = clean_(form.name, 100);
  const email = clean_(form.email, 200).toLowerCase();
  const topic = clean_(form.topic, 1000);
  const preference = ['online', 'inperson'].indexOf(form.preference) >= 0 ? form.preference : 'any';
  const place = preference === 'inperson' ? clean_(form.place, 200) : '';
  let guestTz = clean_(form.timezone, 60);

  if (!name) throw new Error('Please enter your name.');
  if (!validEmail_(email)) throw new Error('Please enter a valid email address.');
  if (form.consent !== true) throw new Error('Please accept the privacy notice.');
  try { Utilities.formatDate(new Date(), guestTz || C().TIMEZONE, 'HH:mm'); } catch (err) { guestTz = ''; }

  let req;
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    rateLimit_();
    const pendingForEmail = allRequests_().filter(function (r) {
      return r.status === 'pending' && r.email === email;
    }).length;
    if (pendingForEmail >= C().MAX_PENDING_PER_EMAIL) {
      throw new Error('You already have open requests. Please wait for a reply before booking again.');
    }
    // searched inside the lock, so two guests sending at the same moment never get the same slot
    const next = getSlots_({})[0];
    if (!next) throw new Error('Sorry, there is no free time in the next ' + C().DAYS_AHEAD + ' days. Please try again later.');
    const start = new Date(next.start);
    const end = new Date(next.end);

    const id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const token = Utilities.getUuid();
    req = {
      id: id, token: token, name: name, email: email, topic: topic, preference: preference, place: place,
      guestTz: guestTz, start: start.toISOString(), end: end.toISOString(),
      status: 'pending', calendarId: C().CALENDAR_ID, created: new Date().toISOString(),
      version: 1, mode: '', location: '', note: '', meetingLink: '', history: [],
    };
    const hold = Calendar.Events.insert({
      summary: '[PENDING] ' + C().MEETING_TITLE.replace('{name}', name),
      description: 'Catch-up request, waiting for your decision.\n\nName: ' + name + '\nEmail: ' + email +
        '\nTopic: ' + (topic || '-') + '\nPrefers: ' + preferenceText_(req) + '\n\nManage: ' + manageUrl_(req, ''),
      start: { dateTime: req.start },
      end: { dateTime: req.end },
      transparency: 'opaque',
      colorId: '5', // yellow
      reminders: { useDefault: false, overrides: [] },
    }, C().CALENDAR_ID);
    req.googleEventId = hold.id;
    addHistory_(req, 'Requested by guest');
    saveRequest_(req);
  } finally {
    lock.releaseLock();
  }

  log_('requested', req);
  notifyOwner_(req);
  emailGuest_(req, 'Request received: ' + shortWhen_(req),
    'Thanks ' + esc_(req.name) + ', your catch-up request has been received. The next free time, <b>' + esc_(guestWhen_(req)) +
    '</b>, is reserved for you.' +
    '<br><br>You will get a confirmation with the final time and the place or the meeting link as soon as ' + esc_(C().OWNER_NAME) + ' confirms it.');
  return { ok: true, when: guestWhen_(req) };
}

/* ============================ Called from the manage page (owner) ============================ */

/** Free slots for moving a catch-up. Its own time counts as free. */
function ownerSlots(id, token) {
  const req = getOwned_(id, token);
  return getSlots_({ excludeId: req.id, owner: true });
}

/**
 * Confirms a pending request or changes a confirmed catch-up.
 * o = { version, mode: 'online'|'inperson', location, note, start (ISO), force }
 */
function saveBooking(id, token, o) {
  o = o || {};
  const mode = o.mode === 'inperson' || o.mode === 'online' ? o.mode : '';
  if (!mode) throw new Error('Choose online or in person.');
  const location = mode === 'inperson' ? clean_(o.location, 300) : '';
  if (mode === 'inperson' && !location) throw new Error('Please enter where you will meet.');
  const note = clean_(o.note, 1000);
  const start = new Date(o.start);
  if (isNaN(start.getTime())) throw new Error('Please pick a time.');
  const end = new Date(start.getTime() + DURATION_MINUTES * 60e3);

  let req, wasConfirmed, before;
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    req = getOwned_(id, token);
    if (ACTIVE_.indexOf(req.status) < 0) throw new Error('This catch-up is already ' + req.status + '.');
    if (Number(o.version) !== req.version) throw new Error('This catch-up was changed in the meantime. Please reload the page.');
    wasConfirmed = req.status === 'confirmed';
    before = { start: req.start, end: req.end, mode: req.mode, location: req.location, note: req.note };

    const timeChanged = start.toISOString() !== req.start || end.toISOString() !== req.end;
    if (timeChanged) {
      if (start.getTime() < Date.now()) throw new Error('The new time is in the past.');
      if (!o.force) {
        const busy = getBusy_(new Date(start.getTime() - 86400e3), new Date(end.getTime() + 86400e3), req.id);
        if (!isFree_(start.getTime(), end.getTime(), busy)) {
          throw new Error('You already have something in your calendar at that time (buffer of ' + C().BUFFER_MINUTES +
            ' minutes included). Tick "Book anyway" to keep this time.');
        }
      }
    }

    const title = C().MEETING_TITLE.replace('{name}', req.name);
    const patch = {
      summary: title + (mode === 'online' ? ' (Google Meet)' : ''),
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      location: location,
      // the guest sees this description, so it never contains the manage link
      description: 'Topic: ' + (req.topic || '-') + '\nGuest: ' + req.name + ' <' + req.email + '>' +
        (mode === 'inperson' ? '\nWhere: ' + location : '') + (note ? '\n\nNote: ' + note : ''),
      attendees: [{ email: req.email, displayName: req.name }],
      transparency: 'opaque',
      colorId: '10', // green
      reminders: { useDefault: true },
    };
    const params = { sendUpdates: 'all' };
    if (mode === 'online' && !req.meetingLink) {
      patch.conferenceData = { createRequest: { requestId: req.id + '-' + req.version, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      params.conferenceDataVersion = 1;
    } else if (mode === 'inperson' && req.meetingLink) {
      patch.conferenceData = null; // removes the Meet link
      params.conferenceDataVersion = 1;
    }

    let ev = patchOrRecreate_(req, patch, params, mode === 'online');
    let link = mode === 'online' ? (meetLink_(ev) || req.meetingLink) : '';
    for (let i = 0; mode === 'online' && !link && i < 5; i++) {
      Utilities.sleep(1500);
      ev = Calendar.Events.get(calId_(req), req.googleEventId);
      link = meetLink_(ev);
    }

    req.start = start.toISOString();
    req.end = end.toISOString();
    req.mode = mode;
    req.location = location;
    req.note = note;
    req.meetingLink = link;
    req.status = 'confirmed';
    req.version += 1;
    if (!wasConfirmed) req.decided = new Date().toISOString();
    addHistory_(req, wasConfirmed ? 'Changed: ' + (changes_(before, req).join(', ') || 'details resent') :
      'Confirmed ' + (mode === 'online' ? 'online' : 'in person'));
    saveRequest_(req);
  } finally {
    lock.releaseLock();
  }

  log_(wasConfirmed ? 'changed' : 'confirmed', req);
  const rows = detailRows_(req, wasConfirmed ? before : null);
  const buttons = actionButtons_(req);
  if (wasConfirmed) {
    emailGuest_(req, 'Updated: catch-up on ' + shortWhen_(req),
      'Hi ' + esc_(req.name) + ', ' + esc_(C().OWNER_NAME) + ' has updated your catch-up. Here are the current details:' +
      rows + '<br>The calendar invite has been updated as well.', buttons);
  } else {
    emailGuest_(req, 'Confirmed: catch-up on ' + shortWhen_(req),
      'Hi ' + esc_(req.name) + ', your catch-up with ' + esc_(C().OWNER_NAME) + ' is confirmed.' +
      rows + '<br>A calendar invite is on its way as well. Need to change something? Just reply to this email.', buttons);
  }
  return manageView_(req);
}

/** Declines a pending request or cancels a confirmed catch-up. */
function cancelBooking(id, token, version, message) {
  const note = clean_(message, 1000);
  let req, wasConfirmed;
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    req = getOwned_(id, token);
    if (ACTIVE_.indexOf(req.status) < 0) throw new Error('This catch-up is already ' + req.status + '.');
    if (Number(version) !== req.version) throw new Error('This catch-up was changed in the meantime. Please reload the page.');
    wasConfirmed = req.status === 'confirmed';
    // a confirmed event has the guest as attendee, so Google sends the cancellation too
    removeEvent_(req, wasConfirmed ? 'all' : 'none');
    req.status = wasConfirmed ? 'cancelled' : 'declined';
    req.version += 1;
    req.decided = new Date().toISOString();
    addHistory_(req, wasConfirmed ? 'Cancelled' : 'Declined');
    saveRequest_(req);
  } finally {
    lock.releaseLock();
  }

  log_(req.status, req);
  const msg = note ? '<br><br><i>' + esc_(note).replace(/\n/g, '<br>') + '</i>' : '';
  if (wasConfirmed) {
    emailGuest_(req, 'Cancelled: catch-up on ' + shortWhen_(req),
      'Hi ' + esc_(req.name) + ', unfortunately ' + esc_(C().OWNER_NAME) + ' has to cancel your catch-up on ' +
      esc_(guestWhen_(req)) + '.' + msg + '<br><br>Feel free to pick a new time.',
      [{ label: 'Pick a new time', url: webAppUrl_() }]);
  } else {
    emailGuest_(req, 'About your catch-up request for ' + shortWhen_(req),
      'Hi ' + esc_(req.name) + ', unfortunately the requested time (' + esc_(guestWhen_(req)) + ') does not work.' +
      msg + '<br><br>Feel free to pick another time.',
      [{ label: 'Pick another time', url: webAppUrl_() }]);
  }
  return manageView_(req);
}

function manageView_(req) {
  return {
    id: req.id, token: req.token, version: req.version, status: req.status,
    name: req.name, email: req.email, topic: req.topic,
    preference: req.preference, preferenceText: preferenceText_(req), place: req.place || '',
    start: req.start, end: req.end, when: formatRange_(req.start, req.end, C().TIMEZONE),
    mode: req.mode || '', location: req.location || '', note: req.note || '', link: req.meetingLink || '',
    locations: C().LOCATIONS || [],
    history: (req.history || []).map(function (h) {
      return { at: Utilities.formatDate(new Date(h.at), C().TIMEZONE, 'd MMM yyyy, HH:mm'), what: h.what };
    }),
  };
}

/* ============================ Maintenance ============================ */

/**
 * Runs hourly (see installTriggers).
 * Releases unanswered holds, picks up changes you made directly in Google Calendar
 * and deletes guest data after the retention period.
 */
function hourlyJob() {
  const now = Date.now();
  allRequests_().forEach(function (r) {
    try {
      if (r.status === 'pending') {
        const tooOld = now - new Date(r.created).getTime() > C().PENDING_EXPIRY_HOURS * 3600e3;
        const tooLate = new Date(r.start).getTime() < now + 3600e3;
        if (tooOld || tooLate) {
          removeEvent_(r, 'none');
          r.status = 'expired';
          r.version += 1;
          addHistory_(r, 'Expired without a decision');
          saveRequest_(r);
          log_('expired', r);
          emailGuest_(r, 'About your catch-up request for ' + shortWhen_(r),
            'Hi ' + esc_(r.name) + ', your request for ' + esc_(guestWhen_(r)) +
            ' could not be confirmed in time, so the slot was released. Sorry about that.',
            [{ label: 'Pick another time', url: webAppUrl_() }]);
          return;
        }
      }
      if (ACTIVE_.indexOf(r.status) >= 0 && new Date(r.end).getTime() > now) {
        syncFromCalendar_(r);
      } else if (ACTIVE_.indexOf(r.status) < 0 || new Date(r.end).getTime() < now) {
        const last = Math.max(new Date(r.end).getTime(), new Date(r.decided || r.created).getTime());
        if (last < now - C().RETENTION_DAYS * 86400e3) {
          props_().deleteProperty('req_' + r.id);
          log_('deleted after retention', { id: r.id, status: r.status });
        }
      }
    } catch (err) {
      console.error('hourlyJob failed for ' + r.id + ': ' + (err.message || err)); // one bad record never stops the others
    }
  });
}

/** Moving or deleting the event in Google Calendar is reflected here, so the tool never shows stale data. */
function syncFromCalendar_(r) {
  let ev;
  try {
    ev = Calendar.Events.get(calId_(r), r.googleEventId);
  } catch (err) {
    if (!/not found|deleted|410|404/i.test(String(err.message || err))) throw err;
    ev = { status: 'cancelled' };
  }
  if (ev.status === 'cancelled') {
    const wasPending = r.status === 'pending';
    r.status = wasPending ? 'declined' : 'cancelled';
    r.version += 1;
    r.decided = new Date().toISOString();
    addHistory_(r, 'Removed in Google Calendar');
    saveRequest_(r);
    log_('removed in calendar', r);
    if (wasPending) {
      // the guest was not on the hold yet, so tell them
      emailGuest_(r, 'About your catch-up request for ' + shortWhen_(r),
        'Hi ' + esc_(r.name) + ', unfortunately the requested time (' + esc_(guestWhen_(r)) + ') does not work.' +
        '<br><br>Feel free to pick another time.', [{ label: 'Pick another time', url: webAppUrl_() }]);
    }
    return;
  }
  const s = ev.start && ev.start.dateTime ? new Date(ev.start.dateTime).toISOString() : r.start;
  const e = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime).toISOString() : r.end;
  if (s !== r.start || e !== r.end) {
    r.start = s;
    r.end = e;
    r.version += 1;
    addHistory_(r, 'Moved in Google Calendar to ' + formatRange_(s, e, C().TIMEZONE));
    saveRequest_(r);
    log_('moved in calendar', r);
  }
}

/** Run once after deploying. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hourlyJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
  Logger.log('Hourly job installed.');
}

/** Run from the editor to authorize and check everything. */
function testSetup() {
  Logger.log('Owner email: ' + ownerEmail_());
  Logger.log('Web app URL: ' + (webAppUrl_() || '(deploy first)'));
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
  const next = getSlots_({})[0];
  Logger.log('Next free time for a guest: ' + (next ? formatRange_(next.start, next.end, C().TIMEZONE) : 'none'));
}

/** Lists all stored catch-ups in the log. */
function listRequests() {
  allRequests_().sort(function (a, b) { return a.start < b.start ? -1 : 1; }).forEach(function (r) {
    Logger.log(r.status.toUpperCase() + '  ' + formatRange_(r.start, r.end, C().TIMEZONE) + '  ' + r.name + ' <' + r.email + '>' +
      (r.mode ? '  ' + (r.mode === 'online' ? 'online' : r.location) : ''));
  });
}

/* ============================ Admin page ============================ */

/** Run once from the editor: creates the secret admin key and logs your private admin URL. */
function setupAdmin() {
  let key = props_().getProperty('ADMIN_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props_().setProperty('ADMIN_KEY', key);
  }
  Logger.log('Your private admin page (bookmark it, do not share it):\n' + webAppUrl_() + '?action=admin&key=' + key);
}

/** Run from the editor if the admin URL ever leaks. The old link stops working immediately. */
function rotateAdminKey() {
  props_().deleteProperty('ADMIN_KEY');
  setupAdmin();
}

function adminKeyOk_(key) {
  const k = props_().getProperty('ADMIN_KEY');
  return !!k && typeof key === 'string' && key.length >= 32 && key === k;
}

function requireAdmin_(key) {
  if (!adminKeyOk_(key)) {
    Utilities.sleep(1500); // slows down guessing
    throw new Error('Not allowed.');
  }
}

function adminGetState(key) {
  requireAdmin_(key);

  let calendars = [];
  let calendarError = '';
  try {
    let pageToken;
    do {
      const r = Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken });
      (r.items || []).forEach(function (c) {
        calendars.push({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, access: c.accessRole });
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
  } catch (err) { calendarError = String(err.message || err); }

  const now = Date.now();
  const requests = allRequests_()
    .filter(function (r) { return ACTIVE_.indexOf(r.status) >= 0 && new Date(r.end).getTime() > now; })
    .sort(function (a, b) { return a.start < b.start ? -1 : 1; })
    .map(function (r) {
      return {
        name: r.name, email: r.email, topic: r.topic, status: r.status,
        mode: r.mode || '', location: r.location || '', link: r.meetingLink || '',
        preference: preferenceText_(r),
        when: formatRange_(r.start, r.end, C().TIMEZONE),
        manageUrl: manageUrl_(r, ''),
      };
    });

  return {
    settings: C(),
    calendars: calendars,
    calendarError: calendarError,
    requests: requests,
    bookingUrl: webAppUrl_(),
    webAppUrlProperty: props_().getProperty('WEB_APP_URL') || '',
    ownerEmail: ownerEmail_(),
  };
}

function adminSave(key, s) {
  requireAdmin_(key);
  s = s || {};
  const out = {};
  function int(v, min, max, label) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n < min || n > max) throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
    return n;
  }

  out.OWNER_NAME = clean_(s.OWNER_NAME, 100) || DEFAULTS.OWNER_NAME;
  out.OWNER_EMAIL = clean_(s.OWNER_EMAIL, 200);
  if (out.OWNER_EMAIL && !validEmail_(out.OWNER_EMAIL)) throw new Error('Notification email is not valid.');
  out.MEETING_TITLE = clean_(s.MEETING_TITLE, 150) || DEFAULTS.MEETING_TITLE;
  out.PAUSED_MESSAGE = clean_(s.PAUSED_MESSAGE, 500) || DEFAULTS.PAUSED_MESSAGE;
  out.PRIVACY_NOTICE = clean_(s.PRIVACY_NOTICE, 1000) || DEFAULTS.PRIVACY_NOTICE;

  out.TIMEZONE = clean_(s.TIMEZONE, 60) || DEFAULTS.TIMEZONE;
  try { Utilities.formatDate(new Date(), out.TIMEZONE, 'Z'); } catch (err) { throw new Error('Unknown time zone: ' + out.TIMEZONE); }

  out.CALENDAR_ID = clean_(s.CALENDAR_ID, 300) || 'primary';
  try {
    const cal = Calendar.CalendarList.get(out.CALENDAR_ID);
    if (cal.accessRole !== 'owner' && cal.accessRole !== 'writer') throw new Error('no write access');
  } catch (err) {
    throw new Error('The main calendar must be one you can edit (' + out.CALENDAR_ID + ').');
  }
  out.EXTRA_BUSY_CALENDARS = (Array.isArray(s.EXTRA_BUSY_CALENDARS) ? s.EXTRA_BUSY_CALENDARS : [])
    .map(function (x) { return clean_(x, 300); }).filter(Boolean).slice(0, 20);
  out.LOCATIONS = String(s.LOCATIONS || '').split('\n')
    .map(function (x) { return clean_(x, 300); }).filter(Boolean).slice(0, 20);

  out.BUFFER_MINUTES = int(s.BUFFER_MINUTES, 0, 240, 'Buffer');
  out.MIN_NOTICE_HOURS = int(s.MIN_NOTICE_HOURS, 0, 720, 'Minimum notice');
  out.DAYS_AHEAD = int(s.DAYS_AHEAD, 1, 60, 'Days ahead');
  out.MAX_PER_DAY = int(s.MAX_PER_DAY, 0, 20, 'Catch-ups per day');
  out.PENDING_EXPIRY_HOURS = int(s.PENDING_EXPIRY_HOURS, 1, 720, 'Request expiry');
  out.MAX_PENDING_PER_EMAIL = int(s.MAX_PENDING_PER_EMAIL, 1, 20, 'Open requests per email');
  out.MAX_REQUESTS_PER_HOUR = int(s.MAX_REQUESTS_PER_HOUR, 1, 200, 'Requests per hour');
  out.RETENTION_DAYS = int(s.RETENTION_DAYS, 1, 365, 'Keep guest data');
  out.WORKING_HOURS = parseHours_(s.WORKING_HOURS);
  out.BOOKING_ENABLED = s.BOOKING_ENABLED === true;

  const url = clean_(s.WEB_APP_URL, 500);
  if (url && !/^https:\/\/script\.google\.com\/\S+\/exec$/.test(url)) throw new Error('The web app URL must be the https://script.google.com/.../exec link.');
  if (url) props_().setProperty('WEB_APP_URL', url);
  else props_().deleteProperty('WEB_APP_URL');

  props_().setProperty('SETTINGS', JSON.stringify(out));
  SETTINGS_CACHE_ = null;
  return adminGetState(key);
}

/** {1: "09:00-12:00, 13:00-17:00", 6: ""} -> {1: [["09:00","12:00"],["13:00","17:00"]]} */
function parseHours_(wh) {
  const names = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const out = {};
  for (let d = 1; d <= 7; d++) {
    const text = clean_(wh && wh[d], 200);
    if (!text) continue;
    const wins = text.split(',').map(function (part) {
      const m = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!m) throw new Error(names[d] + ': use the format 09:00-12:00, 13:00-17:00');
      const from = Number(m[1]) * 60 + Number(m[2]);
      const to = Number(m[3]) * 60 + Number(m[4]);
      if (Number(m[2]) > 59 || Number(m[4]) > 59 || to > 1440 || from >= to) throw new Error(names[d] + ': ' + part.trim() + ' is not a valid time range.');
      return [from, to];
    }).sort(function (a, b) { return a[0] - b[0]; });
    for (let i = 1; i < wins.length; i++) {
      if (wins[i][0] < wins[i - 1][1]) throw new Error(names[d] + ': time ranges overlap.');
    }
    const hhmm = function (n) { return ('0' + Math.floor(n / 60)).slice(-2) + ':' + ('0' + (n % 60)).slice(-2); };
    out[d] = wins.map(function (w) { return [hhmm(w[0]), hhmm(w[1])]; });
  }
  return out;
}

/** Right to erasure: removes every stored record of one guest. Calendar events stay in your calendar. */
function adminDeleteGuest(key, email) {
  requireAdmin_(key);
  email = clean_(email, 200).toLowerCase();
  if (!validEmail_(email)) throw new Error('Please enter a valid email address.');
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  let n = 0;
  try {
    allRequests_().forEach(function (r) {
      if (r.email !== email) return;
      if (r.status === 'pending') removeEvent_(r, 'none'); // an open hold would otherwise block the slot forever
      props_().deleteProperty('req_' + r.id);
      n++;
    });
  } finally {
    lock.releaseLock();
  }
  log_('guest data deleted', { id: '-', status: n + ' records' });
  return n;
}

function adminTest(key) {
  requireAdmin_(key);
  const results = [];
  function run(name, fn) {
    try { results.push({ name: name, ok: true, message: fn() }); }
    catch (err) { results.push({ name: name, ok: false, message: String(err.message || err) }); }
  }
  const start = new Date(), end = new Date(Date.now() + 7 * 86400e3);
  run('Google Calendar', function () { return 'OK, ' + calendarBusy_(start, end, '').length + ' busy blocks in the next 7 days'; });
  if ((C().EXTRA_BUSY_CALENDARS || []).length) {
    run('Extra calendars', function () { return 'OK, ' + freeBusy_(C().EXTRA_BUSY_CALENDARS, start, end).length + ' busy blocks in the next 7 days'; });
  }
  run('Hourly job', function () {
    const on = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'hourlyJob'; });
    if (!on) throw new Error('Not installed. Run installTriggers in the editor.');
    return 'Installed';
  });
  run('Email quota', function () {
    const left = MailApp.getRemainingDailyQuota();
    if (left < 10) throw new Error('Only ' + left + ' emails left today');
    return left + ' emails left today';
  });
  run('Storage', function () {
    const all = props_().getProperties();
    const bytes = Object.keys(all).reduce(function (n, k) { return n + k.length + all[k].length; }, 0);
    const pct = Math.round(bytes / 5120);
    if (pct > 80) throw new Error(pct + '% of 500 KB used. Lower the retention period.');
    return pct + '% of 500 KB used (' + allRequests_().length + ' records)';
  });
  run('Booking page', function () {
    if (!C().BOOKING_ENABLED) return 'Paused, guests see the pause message';
    const next = getSlots_({})[0];
    if (!next) throw new Error('No free time in the next ' + C().DAYS_AHEAD + ' days, new requests would fail');
    return 'Next guest gets ' + formatRange_(next.start, next.end, C().TIMEZONE);
  });
  return results;
}

/* ============================ Availability ============================ */

/**
 * Free 1 hour slots, earliest first.
 * o.excludeId: a catch-up whose own time counts as free (when moving it)
 * o.owner:     you are moving a catch-up, so minimum notice and the daily limit do not apply
 */
function getSlots_(o) {
  const now = new Date();
  const earliest = now.getTime() + (o.owner ? 15 * 60e3 : C().MIN_NOTICE_HOURS * 3600e3);
  const today = Utilities.formatDate(now, C().TIMEZONE, 'yyyy-MM-dd').split('-').map(Number);
  const rangeStart = zoned_(today[0], today[1], today[2], 0, 0);
  const rangeEnd = zoned_(today[0], today[1], today[2] + C().DAYS_AHEAD + 1, 0, 0);
  const busy = getBusy_(rangeStart, rangeEnd, o.excludeId || '');
  const perDay = o.owner ? {} : bookingsPerDay_();
  const slotMs = DURATION_MINUTES * 60e3;
  const stepMs = 30 * 60e3;
  const slots = [];

  for (let i = 0; i <= C().DAYS_AHEAD; i++) {
    const noon = zoned_(today[0], today[1], today[2] + i, 12, 0);
    const dow = Number(Utilities.formatDate(noon, C().TIMEZONE, 'u')); // 1 = Mon ... 7 = Sun
    const dayKey = Utilities.formatDate(noon, C().TIMEZONE, 'yyyy-MM-dd');
    if (C().MAX_PER_DAY && (perDay[dayKey] || 0) >= C().MAX_PER_DAY) continue;
    const parts = dayKey.split('-').map(Number);
    (C().WORKING_HOURS[dow] || []).forEach(function (win) {
      const from = win[0].split(':').map(Number);
      const to = win[1].split(':').map(Number);
      let s = zoned_(parts[0], parts[1], parts[2], from[0], from[1]).getTime();
      const winEnd = zoned_(parts[0], parts[1], parts[2], to[0], to[1]).getTime();
      while (s + slotMs <= winEnd) {
        if (s >= earliest && isFree_(s, s + slotMs, busy)) {
          slots.push({ start: new Date(s).toISOString(), end: new Date(s + slotMs).toISOString() });
        }
        s += stepMs;
      }
    });
  }
  return slots;
}

function getBusy_(start, end, excludeId) {
  const busy = [];
  let skipEventId = '';
  // Pending and confirmed catch-ups always block their slot
  allRequests_().forEach(function (r) {
    if (r.id === excludeId) { skipEventId = r.googleEventId; return; }
    if (ACTIVE_.indexOf(r.status) >= 0) {
      busy.push({ start: new Date(r.start).getTime(), end: new Date(r.end).getTime() });
    }
  });
  calendarBusy_(start, end, skipEventId).forEach(function (b) { busy.push(b); });
  if ((C().EXTRA_BUSY_CALENDARS || []).length) {
    freeBusy_(C().EXTRA_BUSY_CALENDARS, start, end).forEach(function (b) { busy.push(b); });
  }
  return busy;
}

/** Busy events of the main calendar. Reads events (not free/busy) so one event can be left out when moving it. */
function calendarBusy_(start, end, skipEventId) {
  const out = [];
  let pageToken;
  do {
    const r = Calendar.Events.list(C().CALENDAR_ID, {
      timeMin: start.toISOString(), timeMax: end.toISOString(),
      singleEvents: true, maxResults: 2500, pageToken: pageToken,
    });
    (r.items || []).forEach(function (ev) {
      if (ev.id === skipEventId || ev.status === 'cancelled' || ev.transparency === 'transparent') return;
      const me = (ev.attendees || []).filter(function (a) { return a.self; })[0];
      if (me && me.responseStatus === 'declined') return;
      out.push({ start: eventTime_(ev.start), end: eventTime_(ev.end) });
    });
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

function freeBusy_(ids, start, end) {
  const out = [];
  const fb = Calendar.Freebusy.query({
    timeMin: start.toISOString(), timeMax: end.toISOString(),
    items: ids.map(function (id) { return { id: id }; }),
  });
  Object.keys(fb.calendars || {}).forEach(function (k) {
    const cal = fb.calendars[k];
    if (cal.errors && cal.errors.length) throw new Error('Cannot read calendar ' + k + ': ' + JSON.stringify(cal.errors));
    (cal.busy || []).forEach(function (b) {
      out.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
    });
  });
  return out;
}

function eventTime_(t) {
  if (t.dateTime) return new Date(t.dateTime).getTime();
  const p = t.date.split('-').map(Number); // all-day event
  return zoned_(p[0], p[1], p[2], 0, 0).getTime();
}

function isFree_(s, e, busy) {
  const buf = C().BUFFER_MINUTES * 60e3;
  return !busy.some(function (b) { return b.start < e + buf && b.end > s - buf; });
}

function bookingsPerDay_() {
  const out = {};
  allRequests_().forEach(function (r) {
    if (ACTIVE_.indexOf(r.status) < 0) return;
    const k = Utilities.formatDate(new Date(r.start), C().TIMEZONE, 'yyyy-MM-dd');
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

/* ============================ Emails ============================ */

function notifyOwner_(req) {
  MailApp.sendEmail({
    to: ownerEmail_(),
    subject: 'Catch-up request: ' + req.name + ', ' + Utilities.formatDate(new Date(req.start), C().TIMEZONE, 'EEE d MMM, HH:mm'),
    htmlBody: emailHtml_('New catch-up request',
      '<b>' + esc_(req.name) + '</b> (' + esc_(req.email) + ') would like to catch up.' +
      '<br><br><b>Next free time (reserved):</b> ' + esc_(formatRange_(req.start, req.end, C().TIMEZONE)) +
      '<br><b>Prefers:</b> ' + esc_(preferenceText_(req)) +
      '<br><b>Topic:</b> ' + (req.topic ? esc_(req.topic).replace(/\n/g, '<br>') : '-') +
      '<br><br>The slot is held in your calendar until you decide. Each button opens a page where you can set the place, change the time and confirm.',
      [
        { label: 'Confirm online', url: manageUrl_(req, 'online') },
        { label: 'Confirm in person', url: manageUrl_(req, 'inperson') },
        { label: 'Decline', url: manageUrl_(req, 'decline'), muted: true },
      ]),
    name: 'Catch-up booking',
  });
}

function emailGuest_(req, subject, html, buttons) {
  MailApp.sendEmail({
    to: req.email,
    subject: subject,
    htmlBody: emailHtml_(subject, html, buttons || []),
    name: C().OWNER_NAME,
    replyTo: ownerEmail_(),
  });
}

/** Details block for guest emails. With `before`, changed values show what they were. */
function detailRows_(req, before) {
  const rows = [];
  function row(label, now, was) {
    rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b6b78;vertical-align:top">' + label + '</td><td style="padding:4px 0">' + now +
      (was ? '<br><span style="color:#6b6b78;text-decoration:line-through">' + was + '</span>' : '') + '</td></tr>');
  }
  const tz = req.guestTz || C().TIMEZONE;
  const timeWas = before && (before.start !== req.start || before.end !== req.end) ? esc_(formatRange_(before.start, before.end, tz)) : '';
  const whereWas = before && (before.mode !== req.mode || before.location !== req.location) ? esc_(whereText_(before)) : '';
  row('When', '<b>' + esc_(guestWhen_(req)) + '</b>', timeWas);
  row('Where', '<b>' + esc_(whereText_(req)) + '</b>', whereWas);
  if (req.topic) row('Topic', esc_(req.topic).replace(/\n/g, '<br>'));
  if (req.note) row('Note', '<i>' + esc_(req.note).replace(/\n/g, '<br>') + '</i>');
  return '<table style="margin:14px 0;border-collapse:collapse;font-size:15px">' + rows.join('') + '</table>';
}

function actionButtons_(req) {
  if (req.mode === 'online' && req.meetingLink) return [{ label: 'Join with Google Meet', url: req.meetingLink }];
  if (req.mode === 'inperson') {
    return [{ label: 'Open in Google Maps', url: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(req.location) }];
  }
  return [];
}

function emailHtml_(title, body, buttons) {
  const btns = buttons.map(function (b) {
    const bg = b.muted ? '#f1f1f4' : '#1f5eff';
    const fg = b.muted ? '#333' : '#fff';
    return '<a href="' + esc_(b.url) + '" style="display:inline-block;margin:6px 8px 0 0;padding:11px 18px;border-radius:8px;' +
      'background:' + bg + ';color:' + fg + ';text-decoration:none;font-weight:600">' + esc_(b.label) + '</a>';
  }).join('');
  return '<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d1d24;max-width:560px">' +
    '<h2 style="font-size:19px;margin:0 0 14px">' + esc_(title) + '</h2>' + body +
    (btns ? '<div style="margin-top:20px">' + btns + '</div>' : '') + '</div>';
}

/* ============================ Helpers ============================ */

function getOwned_(id, token) {
  const req = getRequest_(id);
  if (!req || !tokenOk_(req, token)) {
    Utilities.sleep(1500); // slows down guessing
    throw new Error('Catch-up not found.');
  }
  return req;
}

function tokenOk_(req, token) { return typeof token === 'string' && token.length >= 32 && token === req.token; }

/** Patches the hold or event. If it was deleted in the calendar meanwhile, a new one is created. */
function patchOrRecreate_(req, patch, params, online) {
  try {
    const ev = Calendar.Events.patch(patch, calId_(req), req.googleEventId, params);
    if (ev.status !== 'cancelled') return ev;
  } catch (err) {
    if (!/not found|deleted|410|404/i.test(String(err.message || err))) throw err;
  }
  const fresh = Object.assign({}, patch);
  delete fresh.conferenceData;
  if (online) {
    // a Meet link of the deleted event is gone with it, so always ask for a new one
    fresh.conferenceData = { createRequest: { requestId: req.id + '-r' + req.version, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  const ev = Calendar.Events.insert(fresh, calId_(req), { sendUpdates: 'all', conferenceDataVersion: 1 });
  req.googleEventId = ev.id;
  req.meetingLink = '';
  return ev;
}

function removeEvent_(req, sendUpdates) {
  try { Calendar.Events.remove(calId_(req), req.googleEventId, { sendUpdates: sendUpdates }); } catch (err) { /* already gone */ }
}

function meetLink_(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;
  const eps = (ev.conferenceData && ev.conferenceData.entryPoints) || [];
  const v = eps.filter(function (x) { return x.entryPointType === 'video'; })[0];
  return v ? v.uri : '';
}

function changes_(before, req) {
  const out = [];
  if (before.start !== req.start || before.end !== req.end) out.push('time');
  if (before.mode !== req.mode) out.push(req.mode === 'online' ? 'now online' : 'now in person');
  else if (before.location !== req.location) out.push('place');
  if (before.note !== req.note) out.push('note');
  return out;
}

function addHistory_(req, what) {
  req.history = (req.history || []).concat([{ at: new Date().toISOString(), what: what }]).slice(-HISTORY_MAX_);
}

function rateLimit_() {
  const cache = CacheService.getScriptCache();
  const k = 'rate_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  const n = Number(cache.get(k) || 0);
  if (n >= C().MAX_REQUESTS_PER_HOUR) throw new Error('Too many requests right now. Please try again in an hour.');
  cache.put(k, String(n + 1), 3700);
}

/** Structured log line in Cloud Logging. Never contains guest names, emails or messages. */
function log_(event, req) {
  console.info(JSON.stringify({ app: 'catchup', event: event, id: req.id, status: req.status, version: req.version }));
}

function preferenceText_(r) {
  if (r.preference === 'online') return 'Online';
  if (r.preference === 'inperson') return 'In person' + (r.place ? ' (' + r.place + ')' : '');
  return 'No preference';
}
function whereText_(r) {
  if (r.mode === 'online') return 'Online (Google Meet)';
  return r.mode === 'inperson' ? r.location : 'To be confirmed';
}

function props_() { return PropertiesService.getScriptProperties(); }
function saveRequest_(r) { props_().setProperty('req_' + r.id, JSON.stringify(r)); }
function getRequest_(id) {
  if (!id || !/^[a-f0-9]{12}$/.test(id)) return null;
  const s = props_().getProperty('req_' + id);
  return s ? JSON.parse(s) : null;
}
function allRequests_() {
  const all = props_().getProperties();
  return Object.keys(all).filter(function (k) { return k.indexOf('req_') === 0; })
    .map(function (k) { return JSON.parse(all[k]); });
}

function ownerEmail_() { return C().OWNER_EMAIL || Session.getEffectiveUser().getEmail(); }
function webAppUrl_() { return props_().getProperty('WEB_APP_URL') || ScriptApp.getService().getUrl(); }
function manageUrl_(req, action) {
  return webAppUrl_() + '?action=manage&id=' + req.id + '&token=' + encodeURIComponent(req.token) + (action ? '&do=' + action : '');
}

/** Date for a wall-clock time in C().TIMEZONE (month 1-12, day may overflow). */
function zoned_(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffsetMs_(new Date(guess));
  t = guess - tzOffsetMs_(new Date(t));
  return new Date(t);
}
function tzOffsetMs_(date) {
  const z = Utilities.formatDate(date, C().TIMEZONE, 'Z'); // e.g. +0200
  const sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10)) * 60000;
}

function formatRange_(startIso, endIso, tz) {
  const s = new Date(startIso), e = new Date(endIso);
  return Utilities.formatDate(s, tz, 'EEEE, d MMMM yyyy, HH:mm') + ' - ' + Utilities.formatDate(e, tz, 'HH:mm') + ' (' + tz + ')';
}
function guestWhen_(req) { return formatRange_(req.start, req.end, req.guestTz || C().TIMEZONE); }
function shortWhen_(req) {
  return Utilities.formatDate(new Date(req.start), req.guestTz || C().TIMEZONE, 'EEE d MMM, HH:mm');
}

function validEmail_(s) { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s); }
function clean_(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeJson_(o) { return JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'); }

function simplePage_(title, msg) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px">' +
    '<h2>' + esc_(title) + '</h2><p>' + esc_(msg) + '</p></div>')
    .setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
