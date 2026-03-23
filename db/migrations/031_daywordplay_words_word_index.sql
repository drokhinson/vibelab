-- Index on daywordplay_words.word for fast dictionary lookups
CREATE INDEX ON public.daywordplay_words USING btree (word);
