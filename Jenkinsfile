pipeline {
  agent any

  tools {
    nodejs 'NodeJS-16'
  }

  parameters {
    string(name: 'POSTMAN_COLLECTION_ID', defaultValue: '11665959-370bf6fc-eb89-4810-855e-f6240947551a', description: 'Postman collection ID')
    string(name: 'POSTMAN_ENV_ID', defaultValue: '11665959-755ed233-7c04-4b97-b95a-e375ba117495', description: 'Postman environment ID')
    string(name: 'POSTMAN_INTEGRATION_ID', defaultValue: '177801-${JOB_NAME}${BUILD_NUMBER}', description: 'Postman integration ID')
  }

  environment {
    POSTMAN_CACHE_DIR = "${JENKINS_HOME}/.postman-cli-cache"
    POSTMAN_BIN = "${JENKINS_HOME}/.postman-cli-cache/PostmanCLI/postman"
    PATH = "${JENKINS_HOME}/.postman-cli-cache/PostmanCLI:${env.PATH}"
  }

  triggers {
    cron('H 3 * * *') // Daily 3AM
  }

  stages {
    stage('Install Postman CLI') {
      steps {
        sh '''
          set -ex
          CACHE_DIR="$POSTMAN_CACHE_DIR"
          INSTALL_DIR="$CACHE_DIR/PostmanCLI"
          POSTMAN_BIN="$INSTALL_DIR/postman"

          if [ ! -f "$POSTMAN_BIN" ]; then
            echo "⬇️ Downloading Postman CLI..."
            mkdir -p "$CACHE_DIR"
            curl -L -o postman-cli.tar.gz https://dl-cli.pstmn.io/download/latest/linux64

            TMP_EXTRACT_DIR="$CACHE_DIR/tmp_extract"
            rm -rf "$TMP_EXTRACT_DIR"
            mkdir -p "$TMP_EXTRACT_DIR"

            tar -xzf postman-cli.tar.gz -C "$TMP_EXTRACT_DIR"
            rm postman-cli.tar.gz

            FOUND_BIN=$(find "$TMP_EXTRACT_DIR" -type f -name postman -o -name postman-cli | head -n 1)
            if [ -z "$FOUND_BIN" ]; then
              echo "❌ Postman binary not found in archive."
              exit 1
            fi

            mkdir -p "$INSTALL_DIR"
            cp "$FOUND_BIN" "$POSTMAN_BIN"
            chmod +x "$POSTMAN_BIN"
            rm -rf "$TMP_EXTRACT_DIR"
          else
            echo "✅ Using cached Postman CLI."
          fi

          "$POSTMAN_BIN" --version
        '''
      }
    }

    stage('Postman CLI Login') {
      steps {
        withCredentials([string(credentialsId: 'POSTMAN_API_KEY', variable: 'POSTMAN_API_KEY')]) {
          sh '''
            set -ex
            echo "🔐 Logging into Postman CLI..."
            "$POSTMAN_BIN" login --with-api-key "$POSTMAN_API_KEY"
          '''
        }
      }
    }

    stage('Run Postman Collection') {
      steps {
        catchError(buildResult: 'SUCCESS', stageResult: 'FAILURE') {
          sh '''
            set -ex
            "$POSTMAN_BIN" collection run "$POSTMAN_COLLECTION_ID" \
              -e "$POSTMAN_ENV_ID" \
              --integration-id "$POSTMAN_INTEGRATION_ID" \
              --reporters cli,json \
              --reporter-json-export results.json
          '''
        }
      }
    }

    stage('Install Node Modules') {
      steps {
        // Assuming your repo includes sync_xray_jira.js and package.json
        sh '''
          npm install
        '''
      }
    }

    stage('Sync Xray and Jira') {
      steps {
        withCredentials([
          string(credentialsId: 'XRAY_CLIENT_ID', variable: 'XRAY_CLIENT_ID'),
          string(credentialsId: 'XRAY_CLIENT_SECRET', variable: 'XRAY_CLIENT_SECRET'),
          string(credentialsId: 'JIRA_USER', variable: 'JIRA_USER'),
          string(credentialsId: 'JIRA_API_TOKEN', variable: 'JIRA_API_TOKEN'),
        ]) {
          withEnv([
            "XRAY_BASE_URL=https://xray.cloud.getxray.app/api/v2",
            "JIRA_BASE_URL=https://yourdomain.atlassian.net",
            "JIRA_PROJECT_KEY=YOURPROJECT",
            "BUG_ISSUE_TYPE=Bug"
          ]) {
            sh '''
              node sync_xray_jira.js results.json
            '''
          }
        }
      }
    }
  }
}
