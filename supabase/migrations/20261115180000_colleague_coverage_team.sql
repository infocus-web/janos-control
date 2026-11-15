-- Personal externo: cuando una persona ajena cubre un evento, se la carga
-- como colega del grupo "Externos" y la cobertura guarda qué equipo la
-- asignó (Pablo / Dylan / Gustavo), para que aparezca en el reparto de ese
-- equipo. Solo agrega la columna (nula para las coberturas existentes).
alter table public.colleague_coverages add column if not exists team text;
