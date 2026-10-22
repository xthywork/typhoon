# Official typhoon data implementation plan

Goal: Replace simulated tracks with directly retrieved official agency data while preserving the existing map and dual timeline.

Architecture: A Python standard-library server serves the site and a same-origin JSON API. Each source adapter produces timestamped observations and forecast bulletins; SQLite preserves real bulletin revisions and last-success data. UI sliders snap to actual observations and bulletin times on one shared date scale. Missing fields remain null, no interpolated observations or forecasts.

- [x] Implement normalized records, input validation and explicit per-source statuses. First sources: JMA public website JSON, HKO published XML, CMA official website JSONP, CWA official website product; authenticated sources remain explicitly pending until credentials and schema can be verified.
- [x] Add bounded concurrent collection, timeouts, five-minute refresh cache, SQLite bulletin archive, same-origin API and safe static serving.
- [x] Replace the synthetic dataset and fixed six-hour/five-batch assumptions. Keep source selection, focus, map, export and sharing; disable controls for empty data.
- [x] Verify live provider parsing, API response, browser map render, independent timestamps, source failure/empty data and export. Document startup, provenance and remaining source restrictions.
