# Design notes

This explains the main decisions behind the precipitation forecast app, what
each one cost, and what testing and review turned up. The
[README](../README.md) covers how to run it.

## The brief and the approach

The brief was to fetch precipitation forecasts from ECMWF Open Data, process
them, and deploy a web app with an innovative front end. The app answers one
question quickly: will it rain here, when, and how much? Everything else
follows from keeping that answer one tap away and the system small enough to
run unattended at no cost.

## Decisions

**No backend.** A scheduled job turns each forecast run into static files,
and a static site reads them. There is no server to keep alive, hosting is
free, and if a build fails the previous forecast stays up. The cost is that
the app can only show what was precomputed, so there are no arbitrary
accumulation windows and no per-user features.

**One image is both the picture and the data.** Each 6-hour field is an 8-bit
grayscale PNG in Web Mercator, with rainfall stored on a square-root scale.
The browser colours it for the map and reads the same pixels back for a
location's numbers, so the map and the chart cannot disagree. A full 15-day
run is 63 images and about 15 MB. The cost is precision and range: values
are exact to about 0.1 mm at 1 mm, and anything above 200 mm in 6 hours is
clipped.

**AIFS rather than IFS.** ECMWF's machine-learning model is published as
soon as it is produced and has uniform 6-hourly steps to 15 days, which keeps
the pipeline simple. The pipeline reads units from the file rather than
assuming them, so switching to IFS needs no code change. The cost is 6-hour
resolution, where IFS offers 3-hourly steps for the first six days.

**Sentences are written by rules, not a language model.** The location card
says things like "Dry until Thursday afternoon, then about 8 mm over 12
hours". A few dozen lines of rules produce it from the 60 values. It is
instant, free, testable, and cannot state a number that is not in the data.
The cost is range: it describes the first wet spell and the wettest day, and
nothing subtler.

**"Time until rain" is computed in the browser.** The first version was
precomputed and counted from the start of the model run. Code review showed
that is 7 to 13 hours wrong by the time anyone looks at it. The browser now
derives it from the 6-hourly frames relative to the current time. The cost is
a second or two of work the first time the layer is opened.

**Layout by flow, not arithmetic.** The header and the location card first
had positions calculated from each other's measured heights. A sweep of 858
window sizes and states found 164 with overlapping panels. They now share
one flex container, and the same sweep finds none.

## What testing and review found

Checks against independent sources caught the errors that looked plausible:

- **Units.** The first build showed 69 metres of rain in six hours. AIFS
  stores precipitation in kg per square metre and IFS in metres. Values are
  now cross-checked against the source file and against Open-Meteo's feed of
  the same run.
- **The dateline.** A unit test on the reprojection found the last image
  column mapped to the wrong side of the world.
- **The encoding ceiling.** A later run contained 121 mm in six hours, above
  the original 100 mm ceiling. A test on the sample data flagged it.
- **Failure handling.** Review found that one failed download could freeze
  the map for the rest of the session, and that every deploy removed files
  an open page still needed. Both are fixed, with browser tests that break
  individual requests to prove it.

Each of the ten review findings has a test, and each test was confirmed to
fail when its fix is removed.

## Limits and next steps

- **No uncertainty.** The app shows one deterministic run. ECMWF also
  publishes a 50-member AIFS ensemble; a "chance of rain" layer is the most
  valuable next step and the largest, at roughly 50 times the data per run.
- **No place search.** Finding a town means finding it on the map.
- **Coarse grid.** Values are 0.25° cell averages, about 28 km, so local
  extremes are smoothed.
- **Scheduled jobs pause.** GitHub disables them after 60 days without
  repository activity. The site then keeps the last run and says how old it
  is.
