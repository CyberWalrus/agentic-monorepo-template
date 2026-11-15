CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"completed" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
