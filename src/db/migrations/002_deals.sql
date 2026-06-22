--
-- Name: deals; Type: TABLE; Schema: public; Owner: xenodeal
--

CREATE TABLE public.deals (
    id integer NOT NULL,
    source_message_id text,
    group_id text NOT NULL,
    sender text NOT NULL,
    deal_score integer,
    category text,
    price numeric,
    price_raw text,
    is_trade boolean DEFAULT false,
    condition text,
    fix_score integer,
    posted_numbers text[],
    status text DEFAULT 'active'::text NOT NULL,
    post_count integer DEFAULT 1,
    first_posted_at timestamp with time zone NOT NULL,
    last_posted_at timestamp with time zone NOT NULL,
    dashboard_label text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    notes text,
    is_noise boolean DEFAULT false NOT NULL,
    raw_text text,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((((((((COALESCE(raw_text, ''::text) || ' '::text) || COALESCE(notes, ''::text)) || ' '::text) || COALESCE(category, ''::text)) || ' '::text) || COALESCE(price_raw, ''::text)) || ' '::text) || COALESCE(condition, ''::text)))) STORED,
    potential_selling_price numeric,
    CONSTRAINT deals_dashboard_label_check CHECK (((dashboard_label = ANY (ARRAY['sale'::text, 'noise'::text, 'sold_confirm'::text, 'not_sold_confirm'::text])) OR (dashboard_label IS NULL))),
    CONSTRAINT deals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'likely_sold'::text, 'confirmed_sold'::text, 'relisted'::text])))
);


ALTER TABLE public.deals OWNER TO xenodeal;

--
-- Name: deals_id_seq; Type: SEQUENCE; Schema: public; Owner: xenodeal
--

CREATE SEQUENCE public.deals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.deals_id_seq OWNER TO xenodeal;

--
-- Name: deals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: xenodeal
--

ALTER SEQUENCE public.deals_id_seq OWNED BY public.deals.id;


--
-- Name: deals id; Type: DEFAULT; Schema: public; Owner: xenodeal
--

ALTER TABLE ONLY public.deals ALTER COLUMN id SET DEFAULT nextval('public.deals_id_seq'::regclass);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: xenodeal
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: deals deals_source_message_id_unique; Type: CONSTRAINT; Schema: public; Owner: xenodeal
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_source_message_id_unique UNIQUE (source_message_id);


--
-- Name: idx_deals_fts; Type: INDEX; Schema: public; Owner: xenodeal
--

CREATE INDEX idx_deals_fts ON public.deals USING gin (search_vector);


--
-- Name: idx_deals_group_sender; Type: INDEX; Schema: public; Owner: xenodeal
--

CREATE INDEX idx_deals_group_sender ON public.deals USING btree (group_id, sender);


--
-- Name: idx_deals_status; Type: INDEX; Schema: public; Owner: xenodeal
--

CREATE INDEX idx_deals_status ON public.deals USING btree (status);


--
-- Name: deals deals_source_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: xenodeal
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES public.messages(message_id);