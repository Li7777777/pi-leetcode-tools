export const GLOBAL_DAILY_QUERY = /* GraphQL */ `
  query dailyCodingChallengeV2 {
    activeDailyCodingChallengeQuestion {
      date
      link
      question {
        questionId
        questionFrontendId
        boundTopicId
        title
        translatedTitle
        titleSlug
        difficulty
        isPaidOnly
        acRate
        status
        content
        translatedContent
        likes
        dislikes
        isLiked
        similarQuestions
        exampleTestcases
        hints
        sampleTestCase
        enableRunCode
        enableTestMode
        enableDebugger
        judgerAvailable
        judgeType
        metaData
        contributors { username profileUrl avatarUrl }
        companyTagStats
        codeSnippets { lang langSlug code }
        stats
        solution { id canSeeDetail paidOnly hasVideoSolution paidOnlyVideo }
        mysqlSchemas
        envInfo
        libraryUrl
        adminUrl
        challengeQuestion { id date incompleteChallengeCount streakCount type }
        note
        topicTags {
          name
          slug
          translatedName
        }
      }
    }
  }
`;

export const CN_DAILY_QUERY = /* GraphQL */ `
  query questionOfToday {
    todayRecord {
      date
      userStatus
      question {
        questionId
        frontendQuestionId: questionFrontendId
        title
        titleCn: translatedTitle
        titleSlug
        difficulty
        paidOnly: isPaidOnly
        acRate
        status
        freqBar
        isFavor
        solutionNum
        hasVideoSolution
        topicTags {
          name
          slug
          id
          nameTranslated: translatedName
        }
        extra { topCompanyTags { imgUrl slug numSubscribed } }
      }
      lastSubmission { id }
    }
  }
`;

const GLOBAL_SUMMARY_FIELDS = /* GraphQL */ `
  questionId
  questionFrontendId
  title
  translatedTitle
  titleSlug
  difficulty
  isPaidOnly
  acRate
  status
  topicTags {
    name
    slug
    translatedName
  }
`;

export const GLOBAL_SEARCH_QUERY = /* GraphQL */ `
  query problemsetQuestionList(
    $categorySlug: String
    $limit: Int
    $skip: Int
    $filters: QuestionListFilterInput
  ) {
    problemsetQuestionList: questionList(
      categorySlug: $categorySlug
      limit: $limit
      skip: $skip
      filters: $filters
    ) {
      total: totalNum
      questions: data {
        ${GLOBAL_SUMMARY_FIELDS}
      }
    }
  }
`;

export const CN_SEARCH_QUERY = /* GraphQL */ `
  query problemsetQuestionList(
    $categorySlug: String
    $limit: Int
    $skip: Int
    $filters: QuestionListFilterInput
  ) {
    problemsetQuestionList(
      categorySlug: $categorySlug
      limit: $limit
      skip: $skip
      filters: $filters
    ) {
      hasMore
      total
      questions {
        frontendQuestionId
        title
        titleCn
        titleSlug
        difficulty
        paidOnly
        acRate
        status
        topicTags {
          name
          nameTranslated
          slug
        }
      }
    }
  }
`;

const PROBLEM_COMMON_FIELDS = /* GraphQL */ `
  ${GLOBAL_SUMMARY_FIELDS}
  boundTopicId
  content
  translatedContent
  likes
  dislikes
  isLiked
  similarQuestions
  hints
  exampleTestcases
  contributors { username profileUrl avatarUrl }
  companyTagStats
  sampleTestCase
  stats
  enableRunCode
  enableTestMode
  judgerAvailable
  judgeType
  metaData
  mysqlSchemas
  libraryUrl
  note
  codeSnippets { lang langSlug code }
`;

export const GLOBAL_PROBLEM_QUERY = /* GraphQL */ `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      ${PROBLEM_COMMON_FIELDS}
      solution { id canSeeDetail paidOnly hasVideoSolution paidOnlyVideo }
      enableDebugger
      envInfo
      adminUrl
      challengeQuestion { id date incompleteChallengeCount streakCount type }
    }
  }
`;

export const CN_PROBLEM_QUERY = /* GraphQL */ `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      ${PROBLEM_COMMON_FIELDS}
      solution { id canSeeDetail }
    }
  }
`;

/** Backward-compatible export for consumers that imported the Global query. */
export const PROBLEM_QUERY = GLOBAL_PROBLEM_QUERY;

export const GLOBAL_USER_PROFILE_QUERY = /* GraphQL */ `
  query userProfile($username: String!) {
    allQuestionsCount {
      difficulty
      count
    }
    matchedUser(username: $username) {
      username
      socialAccounts
      githubUrl
      contributions {
        points
        questionCount
        testcaseCount
      }
      profile {
        realName
        websites
        countryName
        skillTags
        company
        school
        starRating
        aboutMe
        userAvatar
        reputation
        ranking
      }
      submissionCalendar
      submitStats {
        acSubmissionNum {
          difficulty
          count
          submissions
        }
        totalSubmissionNum {
          difficulty
          count
          submissions
        }
      }
      badges {
        id
        displayName
        icon
        creationDate
      }
      upcomingBadges {
        name
        icon
      }
      activeBadge {
        id
      }
    }
    recentSubmissionList(username: $username, limit: 20) {
      title
      titleSlug
      timestamp
      statusDisplay
      lang
    }
  }
`;

export const CN_USER_PROFILE_QUERY = /* GraphQL */ `
  query getUserProfile($username: String!) {
    userProfileUserQuestionProgress(userSlug: $username) {
      numAcceptedQuestions { count difficulty }
      numFailedQuestions { count difficulty }
      numUntouchedQuestions { count difficulty }
    }
    userProfilePublicProfile(userSlug: $username) {
      haveFollowed
      siteRanking
      profile {
        userSlug
        realName
        aboutMe
        asciiCode
        userAvatar
        gender
        websites
        skillTags
        ipRegion
        birthday
        location
        useDefaultAvatar
        certificationLevel
        github
        school: schoolV2 { name }
        company: companyV2 { name }
        job
        globalLocation { country province city overseasCity }
        socialAccounts { provider profileUrl }
        skillSet {
          langLevels { langName langVerboseName level }
          topics { slug name translatedName }
          topicAreaScores { score topicArea { name slug } }
        }
      }
      educationRecordList { unverifiedOrganizationName }
      occupationRecordList { unverifiedOrganizationName jobTitle }
    }
  }
`;

export const GLOBAL_USER_CONTEST_QUERY = /* GraphQL */ `
  query userContestRankingInfo($username: String!) {
    userContestRanking(username: $username) {
      attendedContestsCount
      rating
      globalRanking
      totalParticipants
      topPercentage
      badge { name }
    }
    userContestRankingHistory(username: $username) {
      attended
      trendDirection
      problemsSolved
      totalProblems
      finishTimeInSeconds
      rating
      ranking
      contest { title startTime }
    }
  }
`;

export const CN_USER_CONTEST_QUERY = /* GraphQL */ `
  query userContestRankingInfo($username: String!) {
    userContestRanking(userSlug: $username) {
      attendedContestsCount
      rating
      globalRanking
      localRanking
      globalTotalParticipants
      localTotalParticipants
      topPercentage
    }
    userContestRankingHistory(userSlug: $username) {
      attended
      totalProblems
      trendingDirection
      finishTimeInSeconds
      rating
      score
      ranking
      contest { title titleCn startTime }
    }
  }
`;

export const GLOBAL_USER_STATUS_QUERY = /* GraphQL */ `
  query userStatus {
    userStatus {
      userId
      username
      avatar
      isSignedIn
      isMockUser
      isPremium
      isAdmin
      isSuperuser
      isTranslator
      permissions
    }
  }
`;

export const CN_USER_STATUS_QUERY = /* GraphQL */ `
  query userStatus {
    userStatus {
      isSignedIn
      isAdmin
      isStaff
      isSuperuser
      isTranslator
      isVerified
      isPhoneVerified
      isWechatVerified
      checkedInToday
      username
      realName
      userSlug
      avatar
      region
      permissions
      useTranslation
    }
  }
`;

export const PROGRESS_BY_SLUG_QUERY = /* GraphQL */ `
  query questionProgress($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      ${GLOBAL_SUMMARY_FIELDS}
    }
  }
`;

export const PROGRESS_LIST_QUERY = /* GraphQL */ `
  query userProgressQuestionList($filters: UserProgressQuestionListInput) {
    userProgressQuestionList(filters: $filters) {
      totalNum
      questions {
        difficulty
        frontendId
        lastSubmittedAt
        numSubmitted
        questionStatus
        lastResult
        title
        titleSlug
        translatedTitle
        topicTags {
          name
          nameTranslated
          slug
        }
      }
    }
  }
`;

export const GLOBAL_HISTORY_QUERY = /* GraphQL */ `
  query submissionList(
    $offset: Int!
    $limit: Int!
    $questionSlug: String
  ) {
    submissionList(
      offset: $offset
      limit: $limit
      questionSlug: $questionSlug
    ) {
      hasNext
      submissions {
        id
        title
        titleSlug
        statusDisplay
        lang
        timestamp
        runtime
        memory
        isPending
      }
    }
  }
`;

export const CN_HISTORY_QUERY = /* GraphQL */ `
  query submissionList(
    $offset: Int!
    $limit: Int!
    $lastKey: String
    $questionSlug: String
    $lang: String
    $status: SubmissionStatusEnum
  ) {
    submissionList(
      offset: $offset
      limit: $limit
      lastKey: $lastKey
      questionSlug: $questionSlug
      lang: $lang
      status: $status
    ) {
      lastKey
      hasNext
      submissions {
        id
        title
        status
        statusDisplay
        lang
        langName: langVerboseName
        runtime
        timestamp
        url
        isPending
        memory
        frontendId
      }
    }
  }
`;

export const GLOBAL_RECENT_SUBMISSIONS_QUERY = /* GraphQL */ `
  query recentSubmissions($username: String!, $limit: Int) {
    recentSubmissionList(username: $username, limit: $limit) {
      title
      titleSlug
      timestamp
      statusDisplay
      lang
    }
  }
`;

export const GLOBAL_RECENT_AC_SUBMISSIONS_QUERY = /* GraphQL */ `
  query recentAcSubmissions($username: String!, $limit: Int) {
    recentAcSubmissionList(username: $username, limit: $limit) {
      id
      title
      titleSlug
      time
      timestamp
      statusDisplay
      lang
    }
  }
`;

export const CN_RECENT_AC_SUBMISSIONS_QUERY = /* GraphQL */ `
  query recentAcSubmissions($username: String!) {
    recentACSubmissions(userSlug: $username) {
      submissionId
      submitTime
      question {
        title
        translatedTitle
        titleSlug
        questionFrontendId
      }
    }
  }
`;

export const GLOBAL_SUBMISSION_DETAIL_QUERY = /* GraphQL */ `
  query submissionDetails($id: Int!, $includeCode: Boolean!) {
    submissionDetails(submissionId: $id) {
      id
      runtime
      runtimeDisplay
      runtimePercentile
      memory
      memoryDisplay
      memoryPercentile
      code @include(if: $includeCode)
      timestamp
      statusCode
      lang {
        name
        verboseName
      }
      question {
        questionId
        titleSlug
      }
      runtimeError
      compileError
      lastTestcase
      codeOutput
      expectedOutput
      totalCorrect
      totalTestcases
      stdOutput
    }
  }
`;

export const CN_SUBMISSION_DETAIL_QUERY = /* GraphQL */ `
  query submissionDetails($submissionId: ID!, $includeCode: Boolean!) {
    submissionDetail(submissionId: $submissionId) {
      id
      code @include(if: $includeCode)
      timestamp
      statusDisplay
      runtimeDisplay: runtime
      memoryDisplay: memory
      lang
      langVerboseName
      question {
        questionId
        titleSlug
      }
      runtimePercentile
      memoryPercentile
      passedTestCaseCnt
      totalTestCaseCnt
      stdOutput
      ... on GeneralSubmissionNode {
        outputDetail {
          codeOutput
          expectedOutput
          input
          compileError
          runtimeError
          lastTestcase
        }
      }
      ... on ContestSubmissionNode {
        outputDetail {
          codeOutput
          expectedOutput
          input
          compileError
          runtimeError
          lastTestcase
        }
      }
    }
  }
`;

export const GLOBAL_SOLUTION_ARTICLES_QUERY = /* GraphQL */ `
  query ugcArticleSolutionArticles(
    $questionSlug: String!
    $orderBy: ArticleOrderByEnum
    $userInput: String
    $tagSlugs: [String!]
    $skip: Int
    $first: Int
  ) {
    ugcArticleSolutionArticles(
      questionSlug: $questionSlug
      orderBy: $orderBy
      userInput: $userInput
      tagSlugs: $tagSlugs
      skip: $skip
      first: $first
    ) {
      totalNum
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          title
          topicId
          summary
          slug
          canSee
          hasVideoArticle
        }
      }
    }
  }
`;

export const CN_SOLUTION_ARTICLES_QUERY = /* GraphQL */ `
  query questionTopicsList(
    $questionSlug: String!
    $skip: Int
    $first: Int
    $orderBy: SolutionArticleOrderBy
    $userInput: String
    $tagSlugs: [String!]
  ) {
    questionSolutionArticles(
      questionSlug: $questionSlug
      skip: $skip
      first: $first
      orderBy: $orderBy
      userInput: $userInput
      tagSlugs: $tagSlugs
    ) {
      totalNum
      edges {
        node {
          slug
          canSee
          topic {
            id
          }
          videosInfo {
            coverUrl
          }
        }
      }
    }
  }
`;

export const GLOBAL_SOLUTION_DETAIL_QUERY = /* GraphQL */ `
  query ugcArticleSolutionArticle($topicId: ID) {
    ugcArticleSolutionArticle(topicId: $topicId) {
      title
      slug
      content
      tags {
        slug
      }
      topic {
        id
      }
      prev {
        uuid
        slug
        topicId
        title
      }
      next {
        slug
        topicId
      }
    }
  }
`;

export const CN_SOLUTION_DETAIL_QUERY = /* GraphQL */ `
  query discussTopic($slug: String) {
    solutionArticle(slug: $slug, orderBy: DEFAULT) {
      title
      content
      slug
      tags {
        slug
      }
      topic {
        id
      }
      question {
        titleSlug
      }
      next {
        slug
      }
      prev {
        slug
      }
    }
  }
`;
