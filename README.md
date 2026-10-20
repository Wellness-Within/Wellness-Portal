# Wellness From Within — client portal

The client portal for Dawn Spain, PHom (Wellness From Within). A static site hosted on GitHub Pages; sign-in, client records and the practitioner's private library live in a Supabase database protected by row-level security (see `setup.sql`). No client data or private notes are stored in this repository.

## Files
- `index.html` — the whole app
- `config.js` — the Supabase project URL and public (anon) key
- `setup.sql` — run once in Supabase's SQL Editor to create the table and access rules
- `link.sql` — run once: connects records Dawn creates to a client's sign-in by email, and the safe "connect by hand" merge
- `data/rep-kent.json` — Repertorium Publicum (Kent-based) from the OOREP open data, GPL v3
- `data/mm-boericke.json` — Boericke's Pocket Manual of Homoeopathic Materia Medica (1906, public domain), via OOREP
