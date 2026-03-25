pull-db:
	@mkdir -p ~/db_backup/old
	@if [ -f ~/db_backup/assistant.db ]; then \
		ts=$$(stat -f %Sm -t %Y%m%d-%H%M%S ~/db_backup/assistant.db); \
		mv ~/db_backup/assistant.db ~/db_backup/old/assistant-$$ts.db; \
		[ -f ~/db_backup/assistant.db-wal ] && mv ~/db_backup/assistant.db-wal ~/db_backup/old/assistant-$$ts.db-wal; \
		[ -f ~/db_backup/assistant.db-shm ] && mv ~/db_backup/assistant.db-shm ~/db_backup/old/assistant-$$ts.db-shm; \
		echo "Archived existing db to ~/db_backup/old/assistant-$$ts.db*"; \
	fi
	railway ssh "base64 /data/assistant.db" | base64 --decode > ~/db_backup/assistant.db
	railway ssh "base64 /data/assistant.db-wal" | base64 --decode > ~/db_backup/assistant.db-wal
	railway ssh "base64 /data/assistant.db-shm" | base64 --decode > ~/db_backup/assistant.db-shm
