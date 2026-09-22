CREATE TABLE `campaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`clientName` varchar(128) NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`originalFilename` varchar(255) NOT NULL,
	`sheetName` varchar(128) NOT NULL DEFAULT '',
	`sheetNames` text NOT NULL DEFAULT ('[]'),
	`uploadedAt` timestamp NOT NULL DEFAULT (now()),
	`lastProcessedAt` timestamp,
	`lastRowCount` int DEFAULT 0,
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`)
);
