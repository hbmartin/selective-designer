# Resume unfinished automatic detection

The queue can accept a run even when the application gets an error back. Keep the run active until the worker reports an outcome or its lease expires so accepted work can still publish. After failure or expiry, the image owner can retry without creating a new design or render result.

Record progress with the resulting regions so a retry runs only unfinished work. Restarting the whole detection would spend more provider calls and could replace regions already used in the editor. A replacement attempt owns future writes while completed regions and manual regions keep their identities.
