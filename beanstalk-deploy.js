#!/usr/bin/env node
// Author: Dorian Latchague, https://github.com/DorianLatchague/beanstalk-deploy
// Using a lot of resources from Einar Egilsson's beanstalk-deploy, https://github.com/einaregilsson/beanstalk-deploy

const awsApiRequest = require('./aws-api-request');

const IS_GITHUB_ACTION = !!process.env.GITHUB_ACTION;

if (IS_GITHUB_ACTION) {
    console.error = msg => console.log(`::error::${msg}`);
    console.warn = msg => console.log(`::warning::${msg}`);
}

function createStorageLocation() {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {Operation: 'CreateStorageLocation', Version: '2010-12-01'}
    });
}

function checkIfFileExistsInS3(bucket, s3Key) {
    return awsApiRequest({
        service : 's3', 
        host: `${bucket}.s3.amazonaws.com`,
        path : s3Key,
        method: 'HEAD'
    });
}

function uploadFileToS3(bucket, s3Key, filebuffer) {
    return awsApiRequest({
        service : 's3', 
        host: `${bucket}.s3.amazonaws.com`,
        path : s3Key,
        method: 'PUT',
        headers: { 'Content-Type' : 'application/octet-stream'},
        payload: filebuffer
    });
}

function createBeanstalkVersion(application, bucket, s3Key, versionLabel) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'CreateApplicationVersion', 
            Version: '2010-12-01',
            ApplicationName : application,
            VersionLabel : versionLabel,
            'SourceBundle.S3Bucket' : bucket,
            'SourceBundle.S3Key' : s3Key.substr(1) //Don't want leading / here
        }
    });
}

function deployBeanstalkVersion(application, environmentName, versionLabel) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'UpdateEnvironment', 
            Version: '2010-12-01',
            ApplicationName : application,
            EnvironmentName : environmentName,
            VersionLabel : versionLabel
        }
    });
}

function introduceEnvironmentVariablesIntoJSONFile(file, ECR_REGISTRY, application, environmentName, versionLabel) {
    return file.replace(/^\{\{\s*ECR_REGISTRY\s*\}\}$/g, ECR_REGISTRY).replace(/^\{\{\s*APPLICATION_NAME\s*\}\}$/g, application).replace(/^\{\{\s*ENVIRONMENT_NAME\s*\}\}$/g, environmentName).replace(/^\{\{\s*VERSION_LABEL\s*\}\}$/g,versionLabel);;
}

function describeEvents(application, environmentName, startTime) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'DescribeEvents', 
            Version: '2010-12-01',
            ApplicationName : application,
            Severity : 'TRACE',
            EnvironmentName : environmentName,
            StartTime : startTime.toISOString().replace(/(-|:|\.\d\d\d)/g, '')
        }
    });
}

function describeEnvironments(application, environmentName) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'DescribeEnvironments', 
            Version: '2010-12-01',
            ApplicationName : application,
            'EnvironmentNames.members.1' : environmentName //Yes, that's the horrible way to pass an array...
        }
    });
}

function expect(status, result, extraErrorMessage) {
    if (status !== result.statusCode) { 
        if (extraErrorMessage) {
            console.log(extraErrorMessage);
        }
        if (result.headers['content-type'] !== 'application/json') {
            throw new Error(`Status: ${result.statusCode}. Message: ${result.data}`);
        } else {
            throw new Error(`Status: ${result.statusCode}. Code: ${result.data.Error.Code}, Message: ${result.data.Error.Message}`);
        }
    }
}

//Uploads zip file, creates new version and deploys it
function deployNewVersion(application, environmentName, versionLabel, waitUntilDeploymentIsFinished, waitForRecoverySeconds, dockerrunFile) {
    if (!dockerrunFile) {
        dockerrunFile = `{
            "AWSEBDockerrunVersion": "1",
            "Image": { 
                "Name": "${ECR_REGISTRY}/${application}:${versionLabel}",
                "Update": "true"
            },
            "Ports": [
                {
                "ContainerPort": 8000,
                "HostPort": 8000
                }
            ],
            "Logging": "/var/log/nginx"
        }`
    } else {
        dockerrunFile = introduceEnvironmentVariablesIntoJSONFile(dockerrunFile, ECR_REGISTRY, application, environmentName, versionLabel);
    }
    let s3Key = `/${application}/${versionLabel}/Dockerrun.aws.json`;
    let bucket, deployStart;
    createStorageLocation().then(result => {
        expect(200, result );
        bucket = result.data.CreateStorageLocationResponse.CreateStorageLocationResult.S3Bucket;
        console.log(`Uploading file to bucket ${bucket}`);
        return checkIfFileExistsInS3(bucket, s3Key);
    }).then(result => {
        if (result.statusCode === 200) {
            throw new Error(`Version ${versionLabel} already exists in S3!`);
        }
        expect(404, result); 
        return uploadFileToS3(bucket, s3Key, dockerrunFile);
    }).then(result => {
        expect(200, result);
        console.log(`New build successfully uploaded to S3, bucket=${bucket}, key=${s3Key}`);
        return createBeanstalkVersion(application, bucket, s3Key, versionLabel);
    }).then(result => {
        expect(200, result);
        console.log(`Created new application version ${versionLabel} in Beanstalk.`);
        deployStart = new Date();
        console.log(`Starting deployment of version ${versionLabel} to environment ${environmentName}`);
        return deployBeanstalkVersion(application, environmentName, versionLabel, waitForRecoverySeconds);
    }).then(result => {
        expect(200, result);

        if (waitUntilDeploymentIsFinished) {
            console.log('Deployment started, "wait_for_deployment" was true...\n');
            return waitForDeployment(application, environmentName, versionLabel, deployStart, waitForRecoverySeconds);
        } else {
            console.log('Deployment started, parameter "wait_for_deployment" was false, so action is finished.');
            console.log('**** IMPORTANT: Please verify manually that the deployment succeeds!');
            process.exit(0);
        }

    }).then(envAfterDeployment => {
        if (envAfterDeployment.Health === 'Green') {
            console.log('Environment update successful!');
            process.exit(0);
        } else {
            console.warn(`Environment update finished, but environment health is: ${envAfterDeployment.Health}, HealthStatus: ${envAfterDeployment.HealthStatus}`);
            process.exit(1);
        }
    }).catch(err => {
        console.error(`Deployment failed: ${err}`);
        process.exit(2);
    }); 
}


function strip(val) {
    //Strip leadig or trailing whitespace
    return (val || '').replace(/^\s*|\s*$/g, '');
}

function main() {

    let application, 
        environmentName, 
        versionLabel, 
        region,
        dockerrunFile = "",
        waitForRecoverySeconds = 30, 
        waitUntilDeploymentIsFinished = true; //Whether or not to wait for the deployment to complete...

    if (IS_GITHUB_ACTION) { //Running in GitHub Actions
        application = strip(process.env.INPUT_APPLICATION_NAME);
        environmentName = strip(process.env.INPUT_ENVIRONMENT_NAME);
        versionLabel = strip(process.env.INPUT_VERSION_LABEL);
        ECR_REGISTRY = strip(process.env.INPUT_ECR_REGISTRY);
        dockerrunFile = process.env.INPUT_DOCKERRUN_JSON;

        awsApiRequest.accessKey = strip(process.env.INPUT_AWS_ACCESS_KEY);
        awsApiRequest.secretKey = strip(process.env.INPUT_AWS_SECRET_KEY);
        awsApiRequest.region = strip(process.env.INPUT_REGION);

        if ((process.env.INPUT_WAIT_FOR_DEPLOYMENT || '').toLowerCase() == 'false') {
            waitUntilDeploymentIsFinished = false;
        }

        if (process.env.INPUT_WAIT_FOR_ENVIRONMENT_RECOVERY) {
            waitForRecoverySeconds = parseInt(process.env.INPUT_WAIT_FOR_ENVIRONMENT_RECOVERY);
        }

    } else { //Running as command line script
        if (process.argv.length < 8) {
            console.log('\nbeanstalk-deploy: Deploying ECR info to AWS Elastic Beanstalk');
            console.log('https://github.com/einaregilsson/beanstalk-deploy\n');
            console.log('Usage: beanstalk-deploy.js <application> <environment> <versionLabel> <region> <ECR_REGISTRY> <dockerrunFile> \n');
            console.log('Environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be defined for the program to work.');
            process.exit(1);
        }

        [application, environmentName, versionLabel, region, ECR_REGISTRY, dockerrunFile] = process.argv.slice(2);

        awsApiRequest.accessKey = strip(process.env.AWS_ACCESS_KEY_ID);
        awsApiRequest.secretKey = strip(process.env.AWS_SECRET_ACCESS_KEY);
        awsApiRequest.region = strip(region);
    }

    console.log('Beanstalk-Deploy: GitHub Action for deploying ECR Containers to Elastic Beanstalk.');
    console.log('https://github.com/DorianLatchague/beanstalk-deploy');
    console.log('');

    if (!awsApiRequest.region) {
        console.error('Deployment failed: Region not specified!');
        process.exit(2);
    }
    if (!awsApiRequest.accessKey) {
        console.error('Deployment failed: AWS Access Key not specified!');
        process.exit(2);
    }
    if (!awsApiRequest.secretKey) {
        console.error('Deployment failed: AWS Secret Key not specified!');
        process.exit(2);
    }


    console.log(' ***** Input parameters were: ***** ');
    console.log('         Application: ' + application);
    console.log('         Environment: ' + environmentName);
    console.log('       Version Label: ' + versionLabel);
    console.log('        ECR Registry: ' + ECR_REGISTRY);
    console.log('          AWS Region: ' + awsApiRequest.region);
    console.log('      AWS Access Key: ' + awsApiRequest.accessKey.length + ' characters long, starts with ' + awsApiRequest.accessKey.charAt(0));
    console.log('      AWS Secret Key: ' + awsApiRequest.secretKey.length + ' characters long, starts with ' + awsApiRequest.secretKey.charAt(0));
    console.log('  Dockerrun.aws.json: ' + (dockerrunFile ? 'Provided': 'Not Provided, will use the default single container definition.'));
    console.log(' Wait for deployment: ' + waitUntilDeploymentIsFinished);
    console.log('  Recovery wait time: ' + waitForRecoverySeconds);
    console.log('');

    deployNewVersion(application, environmentName, versionLabel, waitUntilDeploymentIsFinished, waitForRecoverySeconds, dockerrunFile);
}

function formatTimespan(since) {
    let elapsed = new Date().getTime() - since;
    let seconds = Math.floor(elapsed / 1000);
    let minutes = Math.floor(seconds / 60);
    seconds -= (minutes * 60);
    return `${minutes}m${seconds}s`;
}

//Wait until the new version is deployed, printing any events happening during the wait...
function waitForDeployment(application, environmentName, versionLabel, start, waitForRecoverySeconds) {
    let counter = 0;
    let degraded = false;
    let healThreshold;
    let deploymentFailed = false;

    const SECOND = 1000;
    const MINUTE = 60 * SECOND;

    let waitPeriod = 10 * SECOND; //Start at ten seconds, increase slowly, long deployments have been erroring with too many requests.
    let waitStart = new Date().getTime();

    let eventCalls = 0, environmentCalls = 0; // Getting throttled on these print out how many we're doing...

    let consecutiveThrottleErrors = 0;

    return new Promise((resolve, reject) => {
        function update() {

            let elapsed = new Date().getTime() - waitStart;
            
            //Limit update requests for really long deploys
            if (elapsed > (10 * MINUTE)) {
                waitPeriod = 30 * SECOND;
            } else if (elapsed > 5 * MINUTE) {
                waitPeriod = 20 * SECOND;
            }

            describeEvents(application, environmentName, start).then(result => {
                eventCalls++;

                
                //Allow a few throttling failures...
                if (result.statusCode === 400 && result.data && result.data.Error && result.data.Error.Code == 'Throttling') {
                    consecutiveThrottleErrors++;
                    console.log(`Request to DescribeEvents was throttled, that's ${consecutiveThrottleErrors} throttle errors in a row...`);
                    return;
                }

                consecutiveThrottleErrors = 0; //Reset the throttling count

                expect(200, result, `Failed in call to describeEvents, have done ${eventCalls} calls to describeEvents, ${environmentCalls} calls to describeEnvironments in ${formatTimespan(waitStart)}`);
                let events = result.data.DescribeEventsResponse.DescribeEventsResult.Events.reverse(); //They show up in desc, we want asc for logging...
                for (let ev of events) {
                    let date = new Date(ev.EventDate * 1000); //Seconds to milliseconds,
                    console.log(`${date.toISOString().substr(11,8)} ${ev.Severity}: ${ev.Message}`);
                    if (ev.Message.match(/Failed to deploy application/)) {
                        deploymentFailed = true; //wait until next iteration to finish, to get the final messages...
                    }
                }
                if (events.length > 0) {
                    start = new Date(events[events.length-1].EventDate * 1000 + 1000); //Add extra second so we don't get the same message next time...
                }
            }).catch(reject);
    
            describeEnvironments(application, environmentName).then(result => {
                environmentCalls++;

                //Allow a few throttling failures...
                if (result.statusCode === 400 && result.data && result.data.Error && result.data.Error.Code == 'Throttling') {
                    consecutiveThrottleErrors++;
                    console.log(`Request to DescribeEnvironments was throttled, that's ${consecutiveThrottleErrors} throttle errors in a row...`);
                    if (consecutiveThrottleErrors >= 5) {
                        throw new Error(`Deployment failed, got ${consecutiveThrottleErrors} throttling errors in a row while waiting for deployment`);
                    }

                    setTimeout(update, waitPeriod);
                    return;
                }

                expect(200, result, `Failed in call to describeEnvironments, have done ${eventCalls} calls to describeEvents, ${environmentCalls} calls to describeEnvironments in ${formatTimespan(waitStart)}`);

                consecutiveThrottleErrors = 0;
                counter++;
                let env = result.data.DescribeEnvironmentsResponse.DescribeEnvironmentsResult.Environments[0];
                if (env.VersionLabel === versionLabel && env.Status === 'Ready') {
                    if (!degraded) {
                        console.log(`Deployment finished. Version updated to ${env.VersionLabel}`);
                        console.log(`Status for ${application}-${environmentName} is ${env.Status}, Health: ${env.Health}, HealthStatus: ${env.HealthStatus}`);
                       
                        if (env.Health === 'Green') {
                            resolve(env);   
                        } else {
                            console.warn(`Environment update finished, but health is ${env.Health} and health status is ${env.HealthStatus}. Giving it ${waitForRecoverySeconds} seconds to recover...`);
                            degraded = true;
                            healThreshold = new Date(new Date().getTime() + waitForRecoverySeconds * SECOND);
                            setTimeout(update, waitPeriod);
                        }
                    } else {
                        if (env.Health === 'Green') {
                            console.log(`Environment has recovered, health is now ${env.Health}, health status is ${env.HealthStatus}`);
                            resolve(env);
                        } else {
                            if (new Date().getTime() > healThreshold.getTime()) {
                                reject(new Error(`Environment still has health ${env.Health} ${waitForRecoverySeconds} seconds after update finished!`));
                            } else {
                                let left = Math.floor((healThreshold.getTime() - new Date().getTime()) / 1000);
                                console.warn(`Environment still has health: ${env.Health} and health status ${env.HealthStatus}. Waiting ${left} more seconds before failing...`);
                                setTimeout(update, waitPeriod);
                            }
                        }
                    }
                } else if (deploymentFailed) {
                    let msg = `Deployment failed! Current State: Version: ${env.VersionLabel}, Health: ${env.Health}, Health Status: ${env.HealthStatus}`;
                    console.log(`${new Date().toISOString().substr(11,8)} ERROR: ${msg}`);
                    reject(new Error(msg));
                } else {
                    if (counter % 6 === 0 && !deploymentFailed) {
                        console.log(`${new Date().toISOString().substr(11,8)} INFO: Still updating, status is "${env.Status}", health is "${env.Health}", health status is "${env.HealthStatus}"`);
                    }
                    setTimeout(update, waitPeriod);
                }
            }).catch(reject);
        }
    
        update();
    });
}

main();


