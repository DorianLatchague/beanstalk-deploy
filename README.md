# Beanstalk Deploy

Beanstalk Deploy is a GitHub action (and command line script) meant to deploy ECR versions directly to AWS Elastic Beanstalk. 

Thanks to GitHub user [Einar Egilsson](https://github.com/einaregilsson) for providing the base to work from.

### Optional parameters

`dockerrun_json`: You can provide your Dockerrun.aws.json file. You have access to a few parameters inside of this json file.  | SYNTAX                 | VARIABLE         |
            | ---------------------- | ---------------- |
            | ${ECR_REGISTRY}        | ecr_registry     |
            | ${APPLICATION_NAME}    | application_name |
            | ${VERSION_LABEL}       | version_label    |
            | ${ENVIRONMENT_NAME}    | environment_name | Default Dockerrun.aws.json file is: ```
{
    "AWSEBDockerrunVersion": "1",
    "Image": { 
        "Name": "${ECR_REGISTRY}/${APPLICATION}:${VERSION_LABEL}",
        "Update": "true"
    },
    "Ports": [
        {
        "ContainerPort": 8000,
        "HostPort": 8000
        }
    ],
    "Logging": "/var/log/nginx"
}```
`wait_for_deployment`: Whether the action should wait for the deployment to be complete in Elastic Beanstalk. Default is `true`.
Deployments, especially immutable ones can take a long time to complete and eat up a lot of GitHub Actions minutes. So if you prefer
to just start the deployment in Elastic Beanstalk and not wait for it to be completely finished then you can set this parameter to `false`.

`wait_for_environment_recovery`: The environment sometimes takes a while to return to Green status after the deployment
is finished. By default we wait 30 seconds after deployment before determining whether the environment is OK or not. You can
increase this timeout by putting here the number of seconds to wait. Especially smaller environments with less resources
might take a while to return to normal. Thanks to GitHub user [mantaroh](https://github.com/mantaroh) for this one.

### Failure modes
If you're uploading a new version the action will fail if that file already exists in S3, if the application version
exists in Beanstalk and of course if the deployment fails. The action will wait until Beanstalk reports that the
environment is running the version you passed in and status is **Ready**. If health is not **Green** when the version is deployed
the action will wait 30 seconds to see if it recovers, and fail the deployment if it hasn't changed into **Green** mode. The
reason for this is that Beanstalk sometimes messes up health checks during deploys and they usually recover right after
the deployment and in those cases we don't want to fail the build.

## Caveats

1. The S3 upload is a simple PUT request, we don't handle chunked upload. It has worked fine for files that are a 
few megabytes in size, if your files are much larger than that it may cause problems.
2. The script does not roll back if a deploy fails.
3. There is no integration with Git, like there is in the official EB cli. This script only takes a readymade zip file and
deploys it.
