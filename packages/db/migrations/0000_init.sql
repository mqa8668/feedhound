-- feedhound baseline schema (squashed from a pg_dump --schema-only of the migrated database).
-- Requires the unaccent, ltree and pg_trgm extensions.

SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ltree; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA public;

--
-- Name: EXTENSION ltree; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION ltree IS 'data type for hierarchical tree-like structures';

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';

--
-- Name: immutable_unaccent(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.immutable_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
	SELECT unaccent('unaccent', $1)
$_$;

--
-- Name: match_notify_new(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_notify_new() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('match_new', NEW.id::text);
  RETURN NEW;
END;
$$;

--
-- Name: post_notify_new(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_notify_new() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('post_new', NEW.id::text);
  RETURN NEW;
END;
$$;

--
-- Name: post_revision_notify_updated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_revision_notify_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('post_updated', NEW.post_id::text);
  RETURN NEW;
END;
$$;

--
-- Name: source_notify_health(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.source_notify_health() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('source_health', NEW.id::text);
  RETURN NEW;
END;
$$;

--
-- Name: watch_notify_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.watch_notify_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('watch_changed', COALESCE(NEW.id, OLD.id)::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    hash text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);

--
-- Name: app_secret; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_secret (
    name text NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: catalog_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid NOT NULL,
    name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid,
    slug text NOT NULL,
    name text NOT NULL,
    path public.ltree NOT NULL,
    attribute_schema jsonb DEFAULT '[]'::jsonb NOT NULL,
    price_min_vnd bigint,
    price_max_vnd bigint,
    origin text DEFAULT 'seed'::text NOT NULL,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    CONSTRAINT category_origin_check CHECK ((origin = ANY (ARRAY['seed'::text, 'user'::text])))
);

--
-- Name: config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config (
    key text NOT NULL,
    version integer NOT NULL,
    value jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: enrichment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrichment (
    post_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    intent text,
    price_vnd double precision,
    price_raw text,
    condition text,
    category_id uuid,
    item_id uuid,
    confidence double precision,
    engine text DEFAULT 'rule'::text NOT NULL,
    model text,
    prompt_version text,
    tokens integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    text_hash text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    attributes_version integer,
    price_suspect boolean DEFAULT false NOT NULL,
    deal_median_vnd bigint,
    deal_n integer,
    deal_pct real,
    display_title text,
    sentiment text,
    intent_tags text[] DEFAULT '{}'::text[] NOT NULL,
    trend_terms text[],
    price_qualifier text,
    price_max_vnd double precision,
    price_confidence real,
    CONSTRAINT enrichment_condition_check CHECK (((condition IS NULL) OR (condition = ANY (ARRAY['new'::text, 'like_new'::text, 'used'::text, 'broken'::text, 'unknown'::text])))),
    CONSTRAINT enrichment_intent_check CHECK (((intent IS NULL) OR (intent = ANY (ARRAY['sell'::text, 'buy'::text, 'other'::text])))),
    CONSTRAINT enrichment_intent_tags_check CHECK ((intent_tags <@ ARRAY['buy'::text, 'sell'::text, 'ask'::text, 'complain'::text, 'review'::text])),
    CONSTRAINT enrichment_price_qualifier_check CHECK (((price_qualifier IS NULL) OR (price_qualifier = ANY (ARRAY['exact'::text, 'floor'::text, 'ceiling'::text, 'approx'::text, 'range'::text])))),
    CONSTRAINT enrichment_sentiment_check CHECK (((sentiment IS NULL) OR (sentiment = ANY (ARRAY['neg'::text, 'neu'::text, 'pos'::text]))))
);

--
-- Name: insight; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insight (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    topic_id uuid,
    day date NOT NULL,
    dedupe_key text NOT NULL,
    payload jsonb NOT NULL,
    text text NOT NULL,
    delivery text DEFAULT 'inbox'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    delivered_at timestamp with time zone,
    delivery_error text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT insight_delivery_check CHECK ((delivery = ANY (ARRAY['inbox'::text, 'pending'::text, 'sent'::text, 'failed'::text]))),
    CONSTRAINT insight_kind_check CHECK ((kind = ANY (ARRAY['spike'::text, 'digest'::text])))
);

--
-- Name: match; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.match (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    watch_id uuid NOT NULL,
    score double precision NOT NULL,
    matched_terms text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notify_enqueued_at timestamp with time zone
);

--
-- Name: metric_rollup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metric_rollup (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket text NOT NULL,
    ts timestamp with time zone NOT NULL,
    dims jsonb DEFAULT '{}'::jsonb NOT NULL,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT metric_rollup_bucket_check CHECK ((bucket = ANY (ARRAY['hour'::text, 'day'::text])))
);

--
-- Name: notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid,
    notifier_id uuid,
    user_id uuid NOT NULL,
    channel text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_error text,
    provider_message_id text,
    sent_at timestamp with time zone,
    failed_at timestamp with time zone,
    sending_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'merged'::text, 'suppressed'::text, 'failed'::text, 'skipped'::text])))
);

--
-- Name: notifier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifier (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL
);

--
-- Name: post; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    platform_post_id text NOT NULL,
    url text NOT NULL,
    author_name text,
    author_id text,
    title text,
    text text DEFAULT ''::text NOT NULL,
    text_normalized text DEFAULT ''::text NOT NULL,
    media jsonb DEFAULT '[]'::jsonb NOT NULL,
    engagement jsonb DEFAULT '{}'::jsonb NOT NULL,
    posted_at timestamp with time zone,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    edit_count integer DEFAULT 0 NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, public.immutable_unaccent(COALESCE(text_normalized, ''::text)))) STORED,
    visit_id uuid,
    fingerprint text,
    capture text,
    enrich_state text DEFAULT 'pending'::text NOT NULL,
    match_state text DEFAULT 'pending'::text NOT NULL,
    pipeline_version integer DEFAULT 0 NOT NULL,
    pipeline_attempts integer DEFAULT 0 NOT NULL,
    pipeline_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pipeline_reconciled_at timestamp with time zone,
    repost_key text,
    thumb_state text,
    thumb_attempts smallint DEFAULT 0 NOT NULL,
    thumb_checked_at timestamp with time zone,
    text_compact text GENERATED ALWAYS AS (regexp_replace(public.immutable_unaccent(text_normalized), '[^a-z0-9]+'::text, ''::text, 'g'::text)) STORED,
    effective_at timestamp with time zone GENERATED ALWAYS AS (COALESCE(posted_at, first_seen_at)) STORED,
    CONSTRAINT post_capture_check CHECK (((capture IS NULL) OR (capture = ANY (ARRAY['push'::text, 'api'::text])))),
    CONSTRAINT post_enrich_state_check CHECK ((enrich_state = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT post_match_state_check CHECK ((match_state = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT post_thumb_state_check CHECK (((thumb_state IS NULL) OR (thumb_state = ANY (ARRAY['ok'::text, 'none'::text, 'expired'::text, 'failed'::text, 'purged'::text]))))
);

--
-- Name: post_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_revision (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    text text NOT NULL,
    engagement jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: post_user_flag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_user_flag (
    user_id uuid NOT NULL,
    post_id uuid NOT NULL,
    kind text NOT NULL,
    repost_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT post_user_flag_kind_check CHECK ((kind = ANY (ARRAY['saved'::text, 'hidden'::text])))
);

--
-- Name: saved_search; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_search (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    query jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    kind text NOT NULL,
    platform_id text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    schedule jsonb DEFAULT '{}'::jsonb NOT NULL,
    health jsonb DEFAULT '{}'::jsonb NOT NULL,
    assigned_key_id uuid,
    last_ingest_at timestamp with time zone,
    last_health_at timestamp with time zone,
    health_alert_at timestamp with time zone,
    watchdog_alert_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expected_interval_sec integer,
    last_ok_visit_at timestamp with time zone,
    defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT source_kind_check CHECK ((kind = ANY (ARRAY['web'::text, 'telegram'::text, 'push'::text]))),
    CONSTRAINT source_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'paused_by_health'::text])))
);

--
-- Name: source_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_group (
    source_id uuid NOT NULL,
    auto_topic_category_id uuid,
    auto_topic_method text NOT NULL,
    auto_topic_share real,
    auto_region text,
    auto_region_method text NOT NULL,
    auto_region_share real,
    sample_n integer DEFAULT 0 NOT NULL,
    region_sample_n integer DEFAULT 0 NOT NULL,
    classified_at timestamp with time zone,
    override_topic_category_id uuid,
    override_region text,
    overridden_by uuid,
    overridden_at timestamp with time zone,
    CONSTRAINT source_group_region_method_check CHECK ((auto_region_method = ANY (ARRAY['auto'::text, 'default'::text, 'none'::text]))),
    CONSTRAINT source_group_topic_method_check CHECK ((auto_topic_method = ANY (ARRAY['auto'::text, 'mixed'::text, 'default'::text, 'insufficient'::text])))
);

--
-- Name: team; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: topic; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topic (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    saved_search_id uuid,
    name text NOT NULL,
    params jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    alerts_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: topic_volume; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topic_volume (
    topic_id uuid NOT NULL,
    bucket text NOT NULL,
    ts timestamp with time zone NOT NULL,
    posts integer NOT NULL,
    neg integer NOT NULL,
    neu integer NOT NULL,
    pos integer NOT NULL,
    CONSTRAINT topic_volume_bucket_check CHECK ((bucket = ANY (ARRAY['hour'::text, 'day'::text])))
);

--
-- Name: trend_curate_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_curate_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    candidates integer,
    tokens integer DEFAULT 0 NOT NULL,
    outcome text
);

--
-- Name: trend_term; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_term (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "window" text NOT NULL,
    ts timestamp with time zone NOT NULL,
    term text NOT NULL,
    category_id uuid,
    count integer DEFAULT 0 NOT NULL,
    baseline double precision,
    zscore double precision,
    team_id uuid NOT NULL,
    display text,
    lift double precision,
    extractor smallint DEFAULT 1 NOT NULL,
    CONSTRAINT trend_term_window_check CHECK (("window" = ANY (ARRAY['hist'::text, '1h'::text, '24h'::text])))
);

--
-- Name: trend_term_alias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_term_alias (
    team_id uuid NOT NULL,
    term_key text NOT NULL,
    kind text NOT NULL,
    canonical_key text,
    canonical_display text,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trend_term_alias_kind_check CHECK ((kind = ANY (ARRAY['merge'::text, 'drop'::text, 'keep'::text])))
);

--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'hunter'::text NOT NULL,
    telegram_chat_id text,
    link_code text,
    link_code_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_matches_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_role_check CHECK ((role = ANY (ARRAY['hunter'::text, 'operator'::text])))
);

--
-- Name: visit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visit (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    outcome text,
    mode text DEFAULT 'normal'::text NOT NULL,
    posts_seen integer,
    posts_new integer,
    pages integer,
    reached_known_tail boolean,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT visit_mode_check CHECK ((mode = ANY (ARRAY['normal'::text, 'catchup'::text, 'probe'::text]))),
    CONSTRAINT visit_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['ok'::text, 'no_slots'::text, 'blocked'::text, 'timeout'::text, 'error'::text, 'skipped'::text]))))
);

--
-- Name: watch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    include text[] DEFAULT '{}'::text[] NOT NULL,
    include_all text[] DEFAULT '{}'::text[] NOT NULL,
    exclude text[] DEFAULT '{}'::text[] NOT NULL,
    regex text,
    category_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    item_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    price_min double precision,
    price_max double precision,
    intents text[] DEFAULT '{}'::text[] NOT NULL,
    source_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    notifier_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    quiet_hours jsonb,
    muted_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attribute_filters jsonb DEFAULT '[]'::jsonb NOT NULL
);

--
-- Name: api_key api_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_pkey PRIMARY KEY (id);

--
-- Name: app_secret app_secret_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_secret
    ADD CONSTRAINT app_secret_pkey PRIMARY KEY (name);

--
-- Name: catalog_item catalog_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_item
    ADD CONSTRAINT catalog_item_pkey PRIMARY KEY (id);

--
-- Name: category category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category
    ADD CONSTRAINT category_pkey PRIMARY KEY (id);

--
-- Name: config config_key_version_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config
    ADD CONSTRAINT config_key_version_pk PRIMARY KEY (key, version);

--
-- Name: enrichment enrichment_post_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment
    ADD CONSTRAINT enrichment_post_id_pk PRIMARY KEY (post_id);

--
-- Name: insight insight_dedupe_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight
    ADD CONSTRAINT insight_dedupe_key_unique UNIQUE (dedupe_key);

--
-- Name: insight insight_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight
    ADD CONSTRAINT insight_pkey PRIMARY KEY (id);

--
-- Name: match match_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match
    ADD CONSTRAINT match_pkey PRIMARY KEY (id);

--
-- Name: match match_post_watch_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match
    ADD CONSTRAINT match_post_watch_unique UNIQUE (post_id, watch_id);

--
-- Name: metric_rollup metric_rollup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metric_rollup
    ADD CONSTRAINT metric_rollup_pkey PRIMARY KEY (id);

--
-- Name: notification notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (id);

--
-- Name: notifier notifier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifier
    ADD CONSTRAINT notifier_pkey PRIMARY KEY (id);

--
-- Name: post post_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post
    ADD CONSTRAINT post_pkey PRIMARY KEY (id);

--
-- Name: post_revision post_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_revision
    ADD CONSTRAINT post_revision_pkey PRIMARY KEY (id);

--
-- Name: post post_source_platform_post_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post
    ADD CONSTRAINT post_source_platform_post_unique UNIQUE (source_id, platform_post_id);

--
-- Name: post_user_flag post_user_flag_user_id_post_id_kind_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_user_flag
    ADD CONSTRAINT post_user_flag_user_id_post_id_kind_pk PRIMARY KEY (user_id, post_id, kind);

--
-- Name: saved_search saved_search_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_search
    ADD CONSTRAINT saved_search_pkey PRIMARY KEY (id);

--
-- Name: saved_search saved_search_user_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_search
    ADD CONSTRAINT saved_search_user_name_unique UNIQUE (user_id, name);

--
-- Name: source_group source_group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_group
    ADD CONSTRAINT source_group_pkey PRIMARY KEY (source_id);

--
-- Name: source source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source
    ADD CONSTRAINT source_pkey PRIMARY KEY (id);

--
-- Name: team team_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team
    ADD CONSTRAINT team_pkey PRIMARY KEY (id);

--
-- Name: topic topic_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic
    ADD CONSTRAINT topic_pkey PRIMARY KEY (id);

--
-- Name: topic topic_user_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic
    ADD CONSTRAINT topic_user_name_unique UNIQUE (user_id, name);

--
-- Name: topic_volume topic_volume_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_volume
    ADD CONSTRAINT topic_volume_pk PRIMARY KEY (topic_id, bucket, ts);

--
-- Name: trend_curate_run trend_curate_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_curate_run
    ADD CONSTRAINT trend_curate_run_pkey PRIMARY KEY (id);

--
-- Name: trend_term_alias trend_term_alias_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_term_alias
    ADD CONSTRAINT trend_term_alias_pk PRIMARY KEY (team_id, term_key);

--
-- Name: trend_term trend_term_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_term
    ADD CONSTRAINT trend_term_pkey PRIMARY KEY (id);

--
-- Name: user user_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_unique UNIQUE (email);

--
-- Name: user user_link_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_link_code_unique UNIQUE (link_code);

--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

--
-- Name: visit visit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit
    ADD CONSTRAINT visit_pkey PRIMARY KEY (id);

--
-- Name: watch watch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch
    ADD CONSTRAINT watch_pkey PRIMARY KEY (id);

--
-- Name: category_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX category_path_idx ON public.category USING gist (path);

--
-- Name: category_path_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX category_path_unique ON public.category USING btree (path);

--
-- Name: enrichment_attributes_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enrichment_attributes_gin ON public.enrichment USING gin (attributes jsonb_path_ops);

--
-- Name: enrichment_deal_peer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enrichment_deal_peer ON public.enrichment USING btree (item_id) WHERE ((intent = 'sell'::text) AND (price_vnd IS NOT NULL) AND (NOT price_suspect));

--
-- Name: enrichment_filter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enrichment_filter ON public.enrichment USING btree (intent, category_id, item_id, price_vnd);

--
-- Name: enrichment_intent_tags_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enrichment_intent_tags_gin ON public.enrichment USING gin (intent_tags);

--
-- Name: insight_team_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_team_created ON public.insight USING btree (team_id, created_at DESC, id DESC);

--
-- Name: insight_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_user_created ON public.insight USING btree (user_id, created_at DESC, id DESC);

--
-- Name: match_created_at_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX match_created_at_id_idx ON public.match USING btree (created_at DESC, id DESC);

--
-- Name: match_watch_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX match_watch_id_created_at_idx ON public.match USING btree (watch_id, created_at DESC);

--
-- Name: metric_rollup_bucket_ts_dims_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX metric_rollup_bucket_ts_dims_key ON public.metric_rollup USING btree (bucket, ts, dims);

--
-- Name: metric_rollup_metric_team_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metric_rollup_metric_team_ts_idx ON public.metric_rollup USING btree (bucket, ((dims ->> 'metric'::text)), ((dims ->> 'teamId'::text)), ts);

--
-- Name: notification_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_channel_idx ON public.notification USING btree (channel);

--
-- Name: notification_created_at_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_created_at_id_idx ON public.notification USING btree (created_at DESC, id DESC);

--
-- Name: notification_match_no_notifier_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_match_no_notifier_unique ON public.notification USING btree (match_id) WHERE ((match_id IS NOT NULL) AND (notifier_id IS NULL));

--
-- Name: notification_match_notifier_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_match_notifier_unique ON public.notification USING btree (match_id, notifier_id) WHERE (match_id IS NOT NULL);

--
-- Name: notification_no_enabled_notifier_marker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_no_enabled_notifier_marker_idx ON public.notification USING btree (user_id) WHERE ((status = 'suppressed'::text) AND (last_error = 'no enabled notifier'::text));

--
-- Name: notification_ops_dedupe_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_ops_dedupe_key_unique ON public.notification USING btree ((((payload -> 'ops'::text) ->> 'dedupeKey'::text))) WHERE ((channel = 'ops'::text) AND (((payload -> 'ops'::text) ->> 'kind'::text) = 'llm_budget'::text) AND (((payload -> 'ops'::text) ->> 'dedupeKey'::text) IS NOT NULL));

--
-- Name: notification_status_next_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_status_next_attempt_idx ON public.notification USING btree (status, next_attempt_at);

--
-- Name: post_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_author_id ON public.post USING btree (author_id) WHERE (author_id IS NOT NULL);

--
-- Name: post_author_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_author_name_trgm ON public.post USING gin (author_name public.gin_trgm_ops);

--
-- Name: post_effective_at_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_effective_at_id ON public.post USING btree (effective_at DESC, id DESC);

--
-- Name: post_first_seen_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_first_seen_at_idx ON public.post USING btree (first_seen_at);

--
-- Name: post_pipeline_failed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_pipeline_failed_idx ON public.post USING btree (id) WHERE ((enrich_state = 'failed'::text) OR (match_state = 'failed'::text));

--
-- Name: post_pipeline_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_pipeline_pending_idx ON public.post USING btree (pipeline_updated_at) WHERE ((enrich_state = 'pending'::text) OR (match_state = 'pending'::text));

--
-- Name: post_repost_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_repost_key_idx ON public.post USING btree (repost_key);

--
-- Name: post_source_effective_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_source_effective_at ON public.post USING btree (source_id, effective_at DESC);

--
-- Name: post_source_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_source_fingerprint_idx ON public.post USING btree (source_id, fingerprint);

--
-- Name: post_source_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_source_id_idx ON public.post USING btree (source_id);

--
-- Name: post_text_compact_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_text_compact_trgm ON public.post USING gin (text_compact public.gin_trgm_ops);

--
-- Name: post_thumb_todo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_thumb_todo_idx ON public.post USING btree (first_seen_at DESC NULLS LAST) WHERE (thumb_state IS NULL);

--
-- Name: post_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_tsv_idx ON public.post USING gin (tsv);

--
-- Name: post_user_flag_user_kind_repost_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_user_flag_user_kind_repost_idx ON public.post_user_flag USING btree (user_id, kind, repost_key);

--
-- Name: post_visit_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_visit_id_idx ON public.post USING btree (visit_id);

--
-- Name: source_assigned_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_assigned_key_idx ON public.source USING btree (assigned_key_id);

--
-- Name: topic_team_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX topic_team_enabled ON public.topic USING btree (team_id, enabled);

--
-- Name: trend_curate_run_team_ran_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trend_curate_run_team_ran_idx ON public.trend_curate_run USING btree (team_id, ran_at);

--
-- Name: trend_term_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trend_term_latest_idx ON public.trend_term USING btree (team_id, "window", ts DESC) WHERE (category_id IS NULL);

--
-- Name: trend_term_term_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trend_term_term_idx ON public.trend_term USING btree (team_id, term, "window", ts);

--
-- Name: trend_term_top_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trend_term_top_idx ON public.trend_term USING btree (team_id, "window", ts, zscore DESC);

--
-- Name: visit_source_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visit_source_started_idx ON public.visit USING btree (source_id, started_at DESC);

--
-- Name: match match_new_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER match_new_trigger AFTER INSERT ON public.match FOR EACH ROW EXECUTE FUNCTION public.match_notify_new();

--
-- Name: post post_new_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER post_new_trigger AFTER INSERT ON public.post FOR EACH ROW EXECUTE FUNCTION public.post_notify_new();

--
-- Name: post_revision post_revision_updated_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER post_revision_updated_trigger AFTER INSERT ON public.post_revision FOR EACH ROW EXECUTE FUNCTION public.post_revision_notify_updated();

--
-- Name: source source_health_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_health_trigger AFTER UPDATE OF status, health ON public.source FOR EACH ROW WHEN (((new.status IS DISTINCT FROM old.status) OR (new.health IS DISTINCT FROM old.health))) EXECUTE FUNCTION public.source_notify_health();

--
-- Name: watch watch_changed_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER watch_changed_trigger AFTER INSERT OR DELETE OR UPDATE ON public.watch FOR EACH ROW EXECUTE FUNCTION public.watch_notify_changed();

--
-- Name: api_key api_key_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

--
-- Name: catalog_item catalog_item_category_id_category_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_item
    ADD CONSTRAINT catalog_item_category_id_category_id_fk FOREIGN KEY (category_id) REFERENCES public.category(id);

--
-- Name: category category_confirmed_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category
    ADD CONSTRAINT category_confirmed_by_user_id_fk FOREIGN KEY (confirmed_by) REFERENCES public."user"(id);

--
-- Name: enrichment enrichment_category_id_category_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment
    ADD CONSTRAINT enrichment_category_id_category_id_fk FOREIGN KEY (category_id) REFERENCES public.category(id);

--
-- Name: enrichment enrichment_item_id_catalog_item_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment
    ADD CONSTRAINT enrichment_item_id_catalog_item_id_fk FOREIGN KEY (item_id) REFERENCES public.catalog_item(id);

--
-- Name: enrichment enrichment_post_id_post_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment
    ADD CONSTRAINT enrichment_post_id_post_id_fk FOREIGN KEY (post_id) REFERENCES public.post(id);

--
-- Name: insight insight_team_id_team_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight
    ADD CONSTRAINT insight_team_id_team_id_fk FOREIGN KEY (team_id) REFERENCES public.team(id);

--
-- Name: insight insight_topic_id_topic_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight
    ADD CONSTRAINT insight_topic_id_topic_id_fk FOREIGN KEY (topic_id) REFERENCES public.topic(id) ON DELETE CASCADE;

--
-- Name: insight insight_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight
    ADD CONSTRAINT insight_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

--
-- Name: match match_post_id_post_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match
    ADD CONSTRAINT match_post_id_post_id_fk FOREIGN KEY (post_id) REFERENCES public.post(id) ON DELETE CASCADE;

--
-- Name: match match_watch_id_watch_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match
    ADD CONSTRAINT match_watch_id_watch_id_fk FOREIGN KEY (watch_id) REFERENCES public.watch(id) ON DELETE CASCADE;

--
-- Name: notification notification_match_id_match_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_match_id_match_id_fk FOREIGN KEY (match_id) REFERENCES public.match(id) ON DELETE CASCADE;

--
-- Name: notification notification_notifier_id_notifier_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_notifier_id_notifier_id_fk FOREIGN KEY (notifier_id) REFERENCES public.notifier(id);

--
-- Name: notification notification_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id);

--
-- Name: notifier notifier_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifier
    ADD CONSTRAINT notifier_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id);

--
-- Name: post_revision post_revision_post_id_post_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_revision
    ADD CONSTRAINT post_revision_post_id_post_id_fk FOREIGN KEY (post_id) REFERENCES public.post(id);

--
-- Name: post post_source_id_source_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post
    ADD CONSTRAINT post_source_id_source_id_fk FOREIGN KEY (source_id) REFERENCES public.source(id);

--
-- Name: post_user_flag post_user_flag_post_id_post_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_user_flag
    ADD CONSTRAINT post_user_flag_post_id_post_id_fk FOREIGN KEY (post_id) REFERENCES public.post(id) ON DELETE CASCADE;

--
-- Name: post_user_flag post_user_flag_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_user_flag
    ADD CONSTRAINT post_user_flag_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

--
-- Name: post post_visit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post
    ADD CONSTRAINT post_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.visit(id) ON DELETE SET NULL;

--
-- Name: saved_search saved_search_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_search
    ADD CONSTRAINT saved_search_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id);

--
-- Name: source source_assigned_key_id_api_key_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source
    ADD CONSTRAINT source_assigned_key_id_api_key_id_fk FOREIGN KEY (assigned_key_id) REFERENCES public.api_key(id) ON DELETE SET NULL;

--
-- Name: source_group source_group_auto_topic_category_id_category_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_group
    ADD CONSTRAINT source_group_auto_topic_category_id_category_id_fk FOREIGN KEY (auto_topic_category_id) REFERENCES public.category(id) ON DELETE SET NULL;

--
-- Name: source_group source_group_overridden_by_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_group
    ADD CONSTRAINT source_group_overridden_by_user_id_fk FOREIGN KEY (overridden_by) REFERENCES public."user"(id) ON DELETE SET NULL;

--
-- Name: source_group source_group_override_topic_category_id_category_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_group
    ADD CONSTRAINT source_group_override_topic_category_id_category_id_fk FOREIGN KEY (override_topic_category_id) REFERENCES public.category(id) ON DELETE SET NULL;

--
-- Name: source_group source_group_source_id_source_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_group
    ADD CONSTRAINT source_group_source_id_source_id_fk FOREIGN KEY (source_id) REFERENCES public.source(id) ON DELETE CASCADE;

--
-- Name: source source_team_id_team_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source
    ADD CONSTRAINT source_team_id_team_id_fk FOREIGN KEY (team_id) REFERENCES public.team(id);

--
-- Name: topic topic_saved_search_id_saved_search_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic
    ADD CONSTRAINT topic_saved_search_id_saved_search_id_fk FOREIGN KEY (saved_search_id) REFERENCES public.saved_search(id) ON DELETE SET NULL;

--
-- Name: topic topic_team_id_team_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic
    ADD CONSTRAINT topic_team_id_team_id_fk FOREIGN KEY (team_id) REFERENCES public.team(id);

--
-- Name: topic topic_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic
    ADD CONSTRAINT topic_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

--
-- Name: topic_volume topic_volume_topic_id_topic_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_volume
    ADD CONSTRAINT topic_volume_topic_id_topic_id_fk FOREIGN KEY (topic_id) REFERENCES public.topic(id) ON DELETE CASCADE;

--
-- Name: trend_curate_run trend_curate_run_team_id_team_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_curate_run
    ADD CONSTRAINT trend_curate_run_team_id_team_id_fk FOREIGN KEY (team_id) REFERENCES public.team(id) ON DELETE CASCADE;

--
-- Name: trend_term_alias trend_term_alias_team_id_team_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_term_alias
    ADD CONSTRAINT trend_term_alias_team_id_team_id_fk FOREIGN KEY (team_id) REFERENCES public.team(id) ON DELETE CASCADE;

--
-- Name: trend_term trend_term_category_id_category_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_term
    ADD CONSTRAINT trend_term_category_id_category_id_fk FOREIGN KEY (category_id) REFERENCES public.category(id);

--
-- Name: trend_term trend_term_team_id_team_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_term
    ADD CONSTRAINT trend_term_team_id_team_id_fk FOREIGN KEY (team_id) REFERENCES public.team(id) ON DELETE CASCADE;

--
-- Name: user user_team_id_team_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_team_id_team_id_fk FOREIGN KEY (team_id) REFERENCES public.team(id);

--
-- Name: visit visit_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit
    ADD CONSTRAINT visit_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.source(id) ON DELETE CASCADE;

--
-- Name: watch watch_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch
    ADD CONSTRAINT watch_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--

-- Per-install salt for PII masking.
INSERT INTO public.app_secret (name, value) VALUES ('pii_salt', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')) ON CONFLICT DO NOTHING;
