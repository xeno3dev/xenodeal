--- db basis | run first

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: messages; Type: TABLE; Schema: public; Owner: xenodeal
--

CREATE TABLE public.messages (
    message_id character varying NOT NULL,
    group_id character varying NOT NULL,
    sender character varying,
    "timestamp" timestamp with time zone,
    raw_text text,
    has_media boolean DEFAULT false,
    media_ref character varying,
    processed boolean DEFAULT false
);


ALTER TABLE public.messages OWNER TO xenodeal;

--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: xenodeal
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (message_id);


--
-- Name: idx_unprocessed; Type: INDEX; Schema: public; Owner: xenodeal
--

CREATE INDEX idx_unprocessed ON public.messages USING btree (processed) WHERE (processed = false);


--
-- Name: messages messages_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: xenodeal
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(group_id) DEFERRABLE;

    --
-- Name: groups; Type: TABLE; Schema: public; Owner: xenodeal
--

CREATE TABLE public.groups (
    group_id character varying NOT NULL,
    friendly_name character varying NOT NULL,
    active boolean DEFAULT true
);


ALTER TABLE public.groups OWNER TO xenodeal;

--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: xenodeal
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (group_id);