TRUNCATE TABLE spatial_landmarks;
\copy spatial_landmarks FROM 'c:/Users/sonofjacob/OneDrive/Desktop/ELESEND/data/spatial_landmarks_import.tsv' WITH (FORMAT csv, DELIMITER E'\t', QUOTE '"', ESCAPE '"', NULL '\N');
SELECT count(*) AS total_imported, count(DISTINCT region) AS regions_covered FROM spatial_landmarks;
