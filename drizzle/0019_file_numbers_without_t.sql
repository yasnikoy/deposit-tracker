-- File numbers are 26-12345; transfer descriptions write them as T26-12345 and the "T" was kept.
UPDATE `bills_of_lading` SET `file_no` = substr(`file_no`, 2) WHERE `file_no` GLOB 'T[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9]';
